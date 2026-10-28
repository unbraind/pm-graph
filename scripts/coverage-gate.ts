/** Fail closed over every authored runtime module and a complete, unskipped test run. */
import { spawnSync } from "node:child_process";
import { globSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { isMainInvocation } from "./main-invocation.ts";

/** Minimum aggregate percentages, independently enforced by the Node runner. */
interface Thresholds {
  /** Executable source lines exercised. */
  lines: number;
  /** Branch arms exercised. */
  branches: number;
  /** Declared functions invoked. */
  functions: number;
}

/** Visible, reviewable coverage policy from the package manifest. */
interface CoverageConfig {
  /** Required locations; these must cover the independent repository inventory. */
  sources: string[];
  /** Each pattern must select at least one actual test file. */
  tests: string[];
  /** Existing minimum percentages cannot be bypassed with nonnumeric values. */
  thresholds: Thresholds;
  /** Runtime exemptions are forbidden. Type-only modules are detected by emit. */
  ignore: string[];
  /** Additional directory exclusions are forbidden. */
  skipDirs?: string[];
}

/** Structural output, dependencies, fixtures and metadata are never authored runtime inputs. */
const excluded = new Set(["node_modules", "dist", "dist-test", "coverage", "test", "tests", ".agents", ".git"]);

/** Recursively enumerate TypeScript sources, refusing symbolic links that could hide code. */
export function collectSources(root: string, location: string): string[] {
  const target = resolve(root, location);
  const info = statSync(target);
  if (!info.isDirectory()) {
    if (!/\.(?:ts|tsx|mts|cts)$/.test(target) || /\.d\.(?:ts|mts|cts)$/.test(target)) {
      throw new Error(`coverage-gate: not an executable TypeScript source: ${location}`);
    }
    return [relative(root, target).split(sep).join("/")];
  }
  return readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    if (excluded.has(entry.name) && (target === resolve(root) || entry.name === "node_modules")) return [];
    const child = relative(root, join(target, entry.name));
    if (entry.isSymbolicLink()) throw new Error(`coverage-gate: source symlink cannot be audited: ${child}`);
    if (entry.isDirectory()) return collectSources(root, child);
    return /\.(?:ts|tsx|mts|cts)$/.test(entry.name) && !/\.d\.(?:ts|mts|cts)$/.test(entry.name)
      ? [child.split(sep).join("/")] : [];
  });
}

/** Detect modules that erase entirely, without trusting configurable ignore lists. */
export function hasRuntime(root: string, file: string): boolean {
  const source = readFileSync(join(root, file), "utf8");
  if (/(?:node:coverage\s+(?:disable|ignore)|(?:c8|istanbul)\s+ignore)/.test(source)) {
    throw new Error(`coverage-gate: coverage suppression is forbidden: ${file}`);
  }
  const emitted = stripTypeScriptTypes(source);
  return emitted.replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/export\s*\{\s*\}\s*;?/g, "").trim().length > 0;
}

/** Validate manifest inputs before starting the runner or touching an old report. */
export function readPolicy(root: string): CoverageConfig {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { coverageGate?: CoverageConfig };
  const config = manifest.coverageGate;
  if (!config || !Array.isArray(config.sources) || !config.sources.length
      || !Array.isArray(config.tests) || !config.tests.length
      || !Array.isArray(config.ignore) || config.ignore.length || config.skipDirs?.length) {
    throw new Error("coverage-gate: require nonempty sources/tests and no source exemptions");
  }
  for (const dimension of ["lines", "branches", "functions"] as const) {
    const value = config.thresholds?.[dimension];
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`coverage-gate: invalid ${dimension} threshold`);
    }
  }
  return config;
}

/** Compare test paths relative to the root, preserving POSIX case and folding Windows case. */
export function testPathKey(root: string, file: string): string {
  const paths = /^(?:[a-z]:[\\/]|\\\\)/i.test(root) ? win32 : posix;
  const key = paths.relative(root, paths.resolve(root, file.replaceAll("\\", "/"))).replaceAll("\\", "/");
  return paths === win32 ? key.toLowerCase() : key;
}

/** Require declared tests in every selected file and reject skips, TODOs and failures, including suites. */
export function assertCompleteRun(output: string, root: string, tests: string[]): void {
  const declared = new Set<string>();
  let summary = false;
  for (const line of output.trim().split("\n")) {
    const event = JSON.parse(line) as { type: string; data: {
      file?: string; line?: number; name?: string; skip?: boolean | string; todo?: boolean | string;
      details?: { type?: string }; counts?: { failed: number; cancelled: number; skipped: number; todo: number };
    } };
    if (event.type === "test:summary" && event.data.counts) {
      summary = true;
      const counts = event.data.counts;
      if (counts.failed + counts.cancelled + counts.skipped + counts.todo !== 0) {
        throw new Error("coverage-gate: incomplete test run (summary)");
      }
    } else if (event.type === "test:pass" || event.type === "test:fail") {
      if (event.type === "test:fail"
          || (event.data.skip !== undefined && event.data.skip !== false)
          || (event.data.todo !== undefined && event.data.todo !== false)) {
        throw new Error("coverage-gate: incomplete test run (declined or failed test/suite)");
      }
      if (event.data.details?.type === "test" && event.data.line !== undefined && event.data.file) {
        const file = testPathKey(root, event.data.file);
        // Node synthesizes a passing test named after an otherwise empty file.
        const name = event.data.name === undefined ? undefined : testPathKey(root, event.data.name);
        if (name !== undefined && name !== file) declared.add(file);
      }
    }
  }
  if (!summary || tests.some((file) => !declared.has(testPathKey(root, file)))) {
    throw new Error("coverage-gate: incomplete test run (no declared tests or missing summary)");
  }
}

/** Reject missing, empty or partial LCOV receipts against the current runtime inventory. */
export function assertReported(root: string, report: string, required: string[]): void {
  const reported = new Set(report.split("\n").filter((line) => line.startsWith("SF:")).map((line) => {
    const file = line.slice(3).trim();
    return relative(root, isAbsolute(file) ? file : join(root, file)).split(sep).join("/");
  }));
  const missing = required.filter((file) => !reported.has(file));
  if (missing.length) throw new Error(`coverage-gate: sources never loaded: ${missing.join(", ")}`);
}

/** Enforce exact fractional floors from LCOV counts; Node truncates its CLI thresholds to integers. */
export function assertThresholds(report: string, thresholds: Thresholds): void {
  const totals = { LF: 0, LH: 0, BRF: 0, BRH: 0, FNF: 0, FNH: 0 };
  const records = report.split("end_of_record").filter((part) => part.trim());
  if (!records.length) throw new Error("coverage-gate: empty LCOV counters");
  for (const record of records) {
    const counters = new Map([...record.matchAll(/^(LF|LH|BRF|BRH|FNF|FNH):(\d+)$/gm)]
      .map((match) => [match[1], Number(match[2])]));
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
      const value = counters.get(key);
      if (value === undefined || !Number.isSafeInteger(value)) throw new Error(`coverage-gate: invalid LCOV counter ${key}`);
      totals[key] += value;
    }
  }
  for (const [dimension, hit, found] of [
    ["lines", "LH", "LF"], ["branches", "BRH", "BRF"], ["functions", "FNH", "FNF"],
  ] as const) {
    if (totals[hit] > totals[found]) throw new Error(`coverage-gate: impossible ${dimension} counters`);
    const percent = totals[found] === 0 ? 100 : 100 * totals[hit] / totals[found];
    if (percent < thresholds[dimension]) {
      throw new Error(`coverage-gate: ${dimension} coverage ${percent.toFixed(4)}% is below ${thresholds[dimension]}%`);
    }
  }
}

/** Run the real Node coverage engine, then independently verify scope and completion receipts. */
export function runCoverageGate(root: string): void {
  const config = readPolicy(root);
  const inventory = collectSources(root, ".");
  const configured = new Set(config.sources.flatMap((source) => collectSources(root, source)));
  const omitted = inventory.filter((file) => !configured.has(file));
  if (omitted.length) throw new Error(`coverage-gate: sources omitted from policy: ${omitted.join(", ")}`);
  const required = inventory.filter((file) => hasRuntime(root, file));
  if (!required.length) throw new Error("coverage-gate: no runtime sources");
  const tests = config.tests.flatMap((pattern) => {
    const matches = globSync(pattern, { cwd: root }).filter((file) => statSync(join(root, file)).isFile());
    if (!matches.length) throw new Error(`coverage-gate: empty test pattern: ${pattern}`);
    return matches;
  });
  const reportPath = join(root, "coverage", "lcov.info");
  const receiptPath = join(root, "coverage", "test-completion.jsonl");
  mkdirSync(join(root, "coverage"), { recursive: true });
  rmSync(reportPath, { force: true });
  rmSync(receiptPath, { force: true });
  const env: NodeJS.ProcessEnv = { ...process.env, TZ: "UTC" };
  // This is a new runner, including when a regression test invokes the gate.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "--test", "--test-concurrency=2", "--experimental-test-coverage",
    ...required.map((file) => `--test-coverage-include=${file}`),
    `--test-coverage-lines=${config.thresholds.lines}`,
    `--test-coverage-branches=${config.thresholds.branches}`,
    `--test-coverage-functions=${config.thresholds.functions}`,
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    `--test-reporter=${new URL("./completion-reporter.ts", import.meta.url).href}`,
    `--test-reporter-destination=${receiptPath}`,
    "--test-reporter=lcov", `--test-reporter-destination=${reportPath}`,
    ...new Set(tests),
  ], { cwd: root, stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`coverage-gate: runner failed (${result.status})`);
  assertCompleteRun(readFileSync(receiptPath, "utf8"), root, tests);
  const report = readFileSync(reportPath, "utf8");
  assertReported(root, report, required);
  assertThresholds(report, config.thresholds);
  console.log(`coverage-gate: ${required.length} runtime source file(s) reported, complete suite, thresholds met.`);
}

if (isMainInvocation(process.argv, import.meta.url)) runCoverageGate(resolve(import.meta.dirname, ".."));
