/** Exercise the actual gate with small on-disk suites, including deliberate defeat attempts. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { TestEvent } from "node:test/reporters";
import completionReporter from "../scripts/completion-reporter.ts";
import { assertCompleteRun, assertReported, assertThresholds, collectSources, hasRuntime, readPolicy, runCoverageGate } from "../scripts/coverage-gate.ts";
import "../scripts/lint.ts";
import "../scripts/duplication-gate.ts";

/** A real source module and passing test with exact 100 percent coverage. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pmg-coverage-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src/value.ts"), "export const value = 42;\n");
  writeFileSync(join(root, "test/value.test.ts"), 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { value } from "../src/value.ts";\ntest("value", () => assert.equal(value, 42));\n');
  policy(root);
  return root;
}

/** Write a visible manifest policy, optionally applying a deliberate invalid configuration. */
function policy(root: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", coverageGate: {
    sources: ["."], tests: ["test/*.test.ts"], ignore: [],
    thresholds: { lines: 100, branches: 100, functions: 100 }, ...overrides,
  } }));
}

/** Always retire only the synthetic fixture, even when the gate deliberately throws. */
function withFixture(run: (root: string) => void): void {
  const root = fixture();
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("coverage gate passes a complete real suite and replaces stale LCOV", () => withFixture((root) => {
  mkdirSync(join(root, "coverage"));
  writeFileSync(join(root, "coverage/lcov.info"), "SF:stale.ts\n");
  runCoverageGate(root);
  assert.doesNotMatch(readFileSync(join(root, "coverage/lcov.info"), "utf8"), /stale/);
}));

test("coverage gate rejects a new module never loaded by the suite", () => withFixture((root) => {
  writeFileSync(join(root, "src/missing.ts"), "export const missing = 1;\n");
  assert.throws(() => runCoverageGate(root), /sources never loaded: src\/missing.ts/);
}));

test("coverage gate rejects a configured source that no longer exists", () => withFixture((root) => {
  policy(root, { sources: ["absent.ts"] });
  assert.throws(() => runCoverageGate(root), /ENOENT/);
}));

test("coverage gate cannot omit executable scripts or a new root module", () => withFixture((root) => {
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts/tool.ts"), "export const tool = 1;\n");
  writeFileSync(join(root, "entry.mts"), "export const entry = 1;\n");
  policy(root, { sources: ["src"] });
  assert.throws(() => runCoverageGate(root), /sources omitted from policy:.*entry.mts.*scripts\/tool.ts/);
}));

test("coverage gate rejects each empty test pattern instead of accepting a passing sibling", () => withFixture((root) => {
  policy(root, { tests: ["test/*.test.ts", "test/absent*.test.ts"] });
  assert.throws(() => runCoverageGate(root), /empty test pattern/);
}));

for (const mode of ["skip", "todo"] as const) {
  test(`coverage gate rejects a ${mode} suite beside a fully covered passing test`, () => withFixture((root) => {
    writeFileSync(join(root, "test/declined.test.ts"), `import { describe } from "node:test";\ndescribe.${mode}("declined suite", () => {});\n`);
    assert.throws(() => runCoverageGate(root), /incomplete test run/);
  }));
}

test("coverage gate rejects a zero-test file even if it loads every source", () => withFixture((root) => {
  writeFileSync(join(root, "test/value.test.ts"), 'import "../src/value.ts";\n');
  assert.throws(() => runCoverageGate(root), /incomplete test run/);
}));

test("coverage gate propagates real test and coverage threshold failures", () => withFixture((root) => {
  writeFileSync(join(root, "test/value.test.ts"), 'import test from "node:test";\nimport "../src/value.ts";\ntest("failure", () => { throw new Error("intentional"); });\n');
  assert.throws(() => runCoverageGate(root), /runner failed/);
  writeFileSync(join(root, "src/value.ts"), "export function untouched() { return 1; }\n");
  writeFileSync(join(root, "test/value.test.ts"), 'import test from "node:test";\nimport "../src/value.ts";\ntest("loads only", () => {});\n');
  assert.throws(() => runCoverageGate(root), /runner failed/);
}));

test("coverage policy refuses empty, ignored and nonnumeric scopes", () => withFixture((root) => {
  for (const change of [{ sources: [] }, { tests: [] }, { ignore: ["src/value.ts"] }, { skipDirs: ["scripts"] }, { thresholds: { lines: "100" } }]) {
    policy(root, change);
    assert.throws(() => readPolicy(root), /coverage-gate:/);
  }
  writeFileSync(join(root, "package.json"), "{}");
  assert.throws(() => readPolicy(root), /require nonempty/);
}));

test("inventory excludes declarations and structural output, and detects type-only emit", () => withFixture((root) => {
  writeFileSync(join(root, "src/types.ts"), "/** Types only. */ export interface Value { value: number }\n");
  writeFileSync(join(root, "src/value.d.ts"), "export declare const value: number;\n");
  assert.equal(hasRuntime(root, "src/types.ts"), false);
  assert.deepEqual(collectSources(root, "src/value.ts"), ["src/value.ts"]);
  assert.deepEqual(collectSources(root, "."), ["src/types.ts", "src/value.ts"]);
  assert.throws(() => collectSources(root, "package.json"), /not an executable TypeScript/);
  rmSync(join(root, "src/value.ts"));
  assert.throws(() => runCoverageGate(root), /no runtime sources/);
}));

test("inventory refuses a source symlink", () => withFixture((root) => {
  symlinkSync(join(root, "src/value.ts"), join(root, "linked.ts"));
  assert.throws(() => collectSources(root, "."), /source symlink/);
}));

test("completion and file receipts fail closed when absent, partial or nonpassing", () => {
  const root = resolve(".");
  const complete = JSON.stringify({ type: "test:summary", data: { counts: { failed: 0, cancelled: 0, skipped: 0, todo: 0 } } });
  assert.doesNotThrow(() => assertCompleteRun(complete, root, []));
  assert.throws(() => assertCompleteRun("", root, []));
  for (const data of [{ skip: "" }, { todo: "" }, {}]) {
    const type = "skip" in data || "todo" in data ? "test:pass" : "test:fail";
    assert.throws(() => assertCompleteRun(JSON.stringify({ type, data }), root, []), /incomplete/);
  }
  assert.throws(() => assertCompleteRun(complete.replace('"cancelled":0', '"cancelled":1'), root, []), /incomplete/);
  assert.throws(() => assertReported(resolve("."), "", ["missing.ts"]), /never loaded/);
  assert.doesNotThrow(() => assertReported(resolve("."), `SF:${resolve("src/index.ts")}\nSF:src/other.ts\n`, ["src/index.ts", "src/other.ts"]));
});


test("completion reporter serializes actual runner receipts and ignores diagnostic noise", async () => {
  const root = fixture();
  try {
    runCoverageGate(root);
    const receipt = readFileSync(join(root, "coverage/test-completion.jsonl"), "utf8");
    const events = receipt.trim().split("\n").map((line) => JSON.parse(line) as TestEvent);
    async function* source(): AsyncGenerator<TestEvent> {
      yield { type: "test:diagnostic", data: { message: "noise", nesting: 0, level: "info" } };
      yield* events;
    }
    let output = "";
    for await (const chunk of completionReporter(source())) output += chunk;
    assert.equal(output, receipt);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("runtime code cannot opt out using a coverage suppression pragma", () => withFixture((root) => {
  writeFileSync(join(root, "src/value.ts"), "/* node:coverage disable */\nexport const value = 42;\n");
  assert.throws(() => runCoverageGate(root), /coverage suppression is forbidden/);
}));


test("an empty file cannot borrow a passing sibling's declared tests", () => withFixture((root) => {
  writeFileSync(join(root, "test/empty.test.ts"), 'import "../src/value.ts";\n');
  assert.throws(() => runCoverageGate(root), /no declared tests/);
}));

test("structural exclusions apply at the repository root, preserving nested authored modules", () => withFixture((root) => {
  mkdirSync(join(root, "src/dist"));
  writeFileSync(join(root, "src/dist/authored.ts"), "export const authored = true;\n");
  assert.ok(collectSources(root, ".").includes("src/dist/authored.ts"));
}));

test("coverage gate fails when the real runner cannot start", () => withFixture((root) => {
  const executable = process.execPath;
  try {
    process.execPath = join(root, "missing-runtime");
    assert.throws(() => runCoverageGate(root), /ENOENT/);
  } finally { process.execPath = executable; }
}));


test("fractional coverage floors cannot be rounded down by the native runner", () => withFixture((root) => {
  // Native Node accepts this 99.34-percent source with --test-coverage-lines=99.7.
  // Exercise the real gate, so restoring its runner-only threshold check must fail.
  writeFileSync(join(root, "src/value.ts"), "export const value = 42;\n" + "value;\n".repeat(297) + "export function dormant() {\n  return 1;\n}\n");
  policy(root, { thresholds: { lines: 99.7, branches: 0, functions: 0 } });
  assert.throws(() => runCoverageGate(root), /lines coverage .* is below 99.7|runner failed/);
}));

test("LCOV floors reject incomplete or impossible counters and retain fractional precision", () => {
  const report = "SF:source.ts\nLF:1000\nLH:997\nBRF:100\nBRH:95\nFNF:0\nFNH:0\nend_of_record\n";
  assert.throws(() => assertThresholds("", { lines: 0, branches: 0, functions: 0 }), /empty LCOV/);
  assert.doesNotThrow(() => assertThresholds(report, { lines: 99.7, branches: 95, functions: 100 }));
  assert.throws(() => assertThresholds(report, { lines: 99.71, branches: 95, functions: 100 }), /lines coverage/);
  assert.throws(() => assertThresholds(report, { lines: 99.7, branches: 95.1, functions: 100 }), /branches coverage/);
  assert.throws(() => assertThresholds(report.replace("FNF:0", "FNF:1"), { lines: 99.7, branches: 95, functions: 100 }), /functions coverage/);
  assert.throws(() => assertThresholds(report.replace("LH:997", "LH:1001"), { lines: 0, branches: 0, functions: 0 }), /impossible/);
  assert.throws(() => assertThresholds(report.replace("LF:1000", "LF:9007199254740992"), { lines: 0, branches: 0, functions: 0 }), /invalid LCOV/);
  assert.throws(() => assertThresholds(report.replace("LF:1000\n", ""), { lines: 0, branches: 0, functions: 0 }), /invalid LCOV/);
});
