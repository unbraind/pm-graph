import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../src/index.ts";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string; devDependencies: Record<string, string> };
const workspace = mkdtempSync(join(tmpdir(), `${pkg.name}-read-output-`));
const env = { ...process.env, HOME: join(workspace, "home"), GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", PM_AUTHOR: "contract-test", NODE_COMPILE_CACHE: join(workspace, "compile-cache"), npm_config_offline: "true", npm_config_cache: process.env.npm_config_cache ?? join(homedir(), ".npm") };
const ids: string[] = [];
let cli = "";

/** Run a real process without a shell, retaining failure diagnostics. */
function run(bin: string, args: string[], cwd = workspace) {
  return spawnSync(bin, args, { cwd, env, encoding: "utf8", timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
}

/** Require a successful subprocess, with stdout available for fixture creation. */
function success(bin: string, args: string[], cwd = workspace): string {
  const result = run(bin, args, cwd);
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr || result.stdout || result.error}`);
  return result.stdout;
}

/** Invoke the package's installed host against its real tracker. */
function pm(args: string[], expected: number | number[] = 0): Record<string, unknown> {
  const result = run(process.execPath, [cli, "--pm-path", ".agents/pm", "--json", ...args]);
  assert.ok((Array.isArray(expected) ? expected : [expected]).includes(result.status ?? -1), `${args.join(" ")}: ${result.stderr || result.stdout || result.error}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

/** Resolve a declared nested collection in the host's response. */
function rows(result: Record<string, unknown>, path: string): unknown[] {
  const value = path.split(".").reduce<unknown>((current, key) => (current as Record<string, unknown>)?.[key], result);
  assert.ok(Array.isArray(value), `${path} must remain a row collection`);
  return value;
}

before(async () => {
  mkdirSync(env.HOME);
  success("npm", ["pack", "--ignore-scripts", "--pack-destination", workspace], root);
  // npm 10 can emit prepare output despite --ignore-scripts; discover the actual archive.
  const archives = readdirSync(workspace).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1, "pack must produce exactly one distribution archive");
  const tarball = join(workspace, archives[0]!);
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "read-output-consumer", private: true, type: "module" }));
  // Resolve the package's actual executable instead of assuming its layout.
  const host = JSON.parse(readFileSync(join(root, "node_modules/@unbrained/pm-cli/package.json"), "utf8")) as { bin: { pm: string } };
  cli = join(root, "node_modules/@unbrained/pm-cli", host.bin.pm);
  pm(["init", "--defaults", "--agent-guidance", "skip", "--prefix", "synthetic-output-contract-continuation-fixture-with-stable-long-identities"]);
  // Install the actual archive into the documented project extension directory.
  // Reuse the exact installed dependency graph; package-manager acceptance is a separate gate.
  const extensionRoot = join(workspace, ".agents/pm/extensions", pkg.name);
  mkdirSync(extensionRoot, { recursive: true });
  success("tar", ["-xzf", tarball, "--strip-components=1", "-C", extensionRoot]);
  symlinkSync(join(root, "node_modules"), join(extensionRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const client = new PmClient({ pmRoot: join(workspace, ".agents/pm"), author: "contract-test", noExtensions: true });
  for (let index = 0; index < 36; index++) {
    const result = await client.create({ type: "Task", title: `Synthetic output contract row ${index}`, description: "A repeatable fixture with enough content to exercise host budget compaction.", createMode: "progressive" });
    ids.push(result.item.id);
  }
  for (let index = 1; index < ids.length; index++) await client.update(ids[index]!, { blockedBy: ids[index - 1]! });
  writeFileSync(join(workspace, "neo4j-rows.json"), JSON.stringify(ids.map((id) => ({ id, title: "Synthetic provider row" }))));
  Object.assign(env, {
    NEO4J_URI: "bolt://127.0.0.1:9", NEO4J_USER: "synthetic", NEO4J_PASSWORD: "synthetic",
    READ_OUTPUT_NEO4J_ROWS: join(workspace, "neo4j-rows.json"),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${join(root, "test/fixtures/read-output-neo4j-loader.ts")}`,
  });
});
after(() => rmSync(workspace, { recursive: true, force: true }));

const scenarios = [
  { name: "pm-graph ping", args: () => ["pm-graph", "ping"], selector: "version", excluded: "source", paths: [] },
  { name: "pm-graph export", args: () => ["pm-graph", "export"], selector: "graph.nodes.id", excluded: "properties", projectionPath: "graph.nodes", paths: ["graph.nodes", "graph.relationships"] },
  { name: "pm-graph cypher", args: () => ["pm-graph", "cypher"], selector: "statements.statement", excluded: "parameters", projectionPath: "statements", paths: ["statements"] },
  { name: "pm-graph status", args: () => ["pm-graph", "status"], selector: "localItemCount", excluded: "workspace", paths: [] },
  { name: "pm-graph query", args: () => ["pm-graph", "query", "MATCH (n) RETURN n.id AS id"], selector: "records.id", excluded: "title", projectionPath: "records", paths: ["records"] },
  { name: "pm-graph neighbors", args: () => ["pm-graph", "neighbors", ids[0]!], selector: "neighbors.node.properties.id", excluded: "relationship", projectionPath: "neighbors", paths: ["neighbors"] },
  { name: "pm-graph analyze", args: () => ["pm-graph", "analyze"], selector: "depthByItem.id", excluded: "depth", projectionPath: "depthByItem", paths: ["depthByItem"] },
  { name: "pm-graph cycles", args: () => ["pm-graph", "cycles"], selector: "cycles", excluded: "cycleCount", paths: ["cycles"] },
  { name: "pm-graph path", args: () => ["pm-graph", "path", ids[1]!, ids[0]!], selector: "path", excluded: "from", paths: [] },
  { name: "pm-graph critical-path", args: () => ["pm-graph", "critical-path"], selector: "path", excluded: "length", paths: ["path"] },
  { name: "pm-graph topo-sort", args: () => ["pm-graph", "topo-sort"], selector: "order", excluded: "ok", paths: ["order"] },
  { name: "pm-graph impact", args: () => ["pm-graph", "impact", ids[0]!, "--depth", "100", "--limit", "100"], selector: "impacted", excluded: "cost", paths: ["impacted"] },
  { name: "pm-graph explain", args: () => ["pm-graph", "explain", ids[0]!], selector: "dependents", excluded: "item", paths: ["transitiveDependents"] },
];

for (const scenario of scenarios) {
  test(`${scenario.name}: packaged host projection, omission, and exact row recovery`, () => {
    const args = scenario.args();
    const full = pm([...args, "--output-budget", "unbounded", "--output-limit", "unbounded", "--output-row-contract"]);
    const receipt = full.read_output as { command: string };
    assert.equal(receipt.command, `extension:${scenario.name}`);
    const projected = pm([...args, "--output-budget", "unbounded", "--output-include", scenario.selector]);
    assert.ok(projected.read_output, "projection must carry a receipt");
    const subject = scenario.projectionPath ? rows(projected, scenario.projectionPath)[0] as Record<string, unknown> : projected;
    assert.equal(subject[scenario.excluded], undefined, "unselected data must be omitted");
    const omitted = pm([...args, "--output-budget", "1"], 2);
    assert.ok(omitted.output_budget_exceeded, "infeasible budget must produce the shared omission branch");
    for (const path of scenario.paths) {
      const expected = rows(full, path);
      if (expected.length < 3) continue;
      const controls = ["--output-include", path, "--output-limit", "unbounded"];
      let page: Record<string, unknown> | undefined;
      let budget = 0;
      for (const candidate of [8100, 5400, 3600, 2400, 1600, 1200, 1000, 800, 600, 400]) {
        const raw = run(process.execPath, [cli, "--pm-path", ".agents/pm", "--json", ...args, ...controls, "--output-budget", String(candidate)]);
        assert.ok(raw.status === 0 || raw.status === 2, raw.stderr || raw.stdout);
        const result = JSON.parse(raw.stdout) as Record<string, unknown>;
        if (raw.status === 0 && result.output_budget_truncation) { page = result; budget = candidate; break; }
      }
      if (!page) {
        // Empty/singleton or short collections need no continuation.
        assert.ok(expected.length < 3, `${path} fixture must exercise budget continuation`);
        continue;
      }
      const bounded = page.read_output as { estimated_tokens: number; within_budget: boolean };
      assert.equal(bounded.within_budget, true);
      assert.ok(bounded.estimated_tokens <= budget, "receipt must fit the requested budget");
      const actual: unknown[] = [];
      const cursors = new Set<string>();
      for (let index = 0; index <= expected.length; index++) {
        actual.push(...rows(page, path));
        const truncation = page.output_budget_truncation as { continuations?: Array<{ path: string; cursor: string }> } | undefined;
        const next = truncation?.continuations?.find((entry) => entry.path === path);
        if (!next) break;
        assert.ok(!cursors.has(next.cursor), "continuation must advance");
        cursors.add(next.cursor);
        page = pm([...args, ...controls, "--output-budget", String(budget), "--output-cursor", next.cursor], [0, 2]);
        // Later rows can be larger than the first page; retry an explicit omission with more capacity.
        for (let retry = 0; page.output_budget_exceeded && retry < 4; retry++) {
          budget *= 2;
          page = pm([...args, ...controls, "--output-budget", String(budget), "--output-cursor", next.cursor], [0, 2]);
        }
        assert.equal(page.output_budget_exceeded, undefined, "continuation must fit after bounded recovery");
        const receipt = page.read_output as { estimated_tokens: number; within_budget: boolean };
        assert.equal(receipt.within_budget, true);
        assert.ok(receipt.estimated_tokens <= budget, "each continuation receipt must fit its budget");
      }
      assert.deepEqual(actual, expected, `${path}: every row must return once, unchanged and in order`);
    }
  });
}

test("sync rejects read controls before any provider write", () => {
  const result = run(process.execPath, [cli, "--pm-path", ".agents/pm", "pm-graph", "sync", "--output-budget", "1000"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr + result.stdout, /read|output/i);
});

test("raw exports remain documents; universal controls select structured rows", () => {
  const ordinary = run(process.execPath, [cli, "--pm-path", ".agents/pm", "pm-graph", "export", "--format", "mermaid"]);
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.match(ordinary.stdout, /^%%\{init:[^\n]+\}%%\ngraph TD\n/u);
  const structured = pm(["pm-graph", "export", "--format", "mermaid", "--output-include", "graph.nodes.id", "--output-budget", "unbounded"]);
  assert.equal(rows(structured, "graph.nodes").filter((row) => ids.includes((row as { id: string }).id)).length, ids.length);
  const path = join(workspace, "must-not-exist.mmd");
  const file = run(process.execPath, [cli, "--pm-path", ".agents/pm", "pm-graph", "export", "--format", "mermaid", "--output", path, "--output-budget", "1000"]);
  assert.equal(file.status, 2);
  assert.equal(existsSync(path), false);
});

/** The caller selected a file, so the host must not render exported graph rows on stdout. */
test("file export receipts stay small: the written file carries the graph", () => {
  const target = join(workspace, "file-receipt.json");
  const result = run(process.execPath, [cli, "--pm-path", ".agents/pm", "pm-graph", "export", "--format", "json", "--output", target, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout) as { ok: boolean; file: string; nodes: number; graph: { nodes: unknown[]; relationships: unknown[] } };
  assert.equal(receipt.ok, true);
  assert.equal(receipt.file, target, "the receipt names the written file");
  assert.ok(existsSync(target), "the rendered graph was written to the file");
  const written = JSON.parse(readFileSync(target, "utf8")) as { graph: { nodes: unknown[] } };
  assert.ok(Array.isArray(written.graph?.nodes), "the file contains the rendered graph");
  assert.equal(receipt.nodes, written.graph.nodes.length, "the receipt reports the written node count");
  assert.deepEqual(receipt.graph, { nodes: [], relationships: [] }, "the file receipt must not embed graph rows");
  for (const id of ids) assert.ok(!result.stdout.includes(id), "stdout must not render exported nodes");
  // The default TOON renderer must stay small as well: the graph is in the file.
  const toonTarget = join(workspace, "file-receipt-toon.json");
  const toon = run(process.execPath, [cli, "--pm-path", ".agents/pm", "pm-graph", "export", "--format", "json", "--output", toonTarget]);
  assert.equal(toon.status, 0, toon.stderr);
  assert.ok(existsSync(toonTarget), "the file was written without --json");
  for (const id of ids) assert.ok(!toon.stdout.includes(id), "default TOON stdout must not render exported nodes");
});

test("diagram variants cannot emit unbudgeted stdout alongside structured output", () => {
  for (const command of [["critical-path"], ["impact", ids[0]!]]) {
    const result = pm(["pm-graph", ...command, "--format", "mermaid", "--output-include", "path,impacted", "--output-budget", "unbounded"]);
    assert.ok(result.read_output);
    assert.equal(result.diagram, undefined);
  }
});

/** Exercise the source handlers with per-call SDK options and CLI globals. */
test("SDK controls select structured exports and suppress diagram side output", async () => {
  const harness = await createExtensionTestHarness(extension, { name: "pm-graph", capabilities: ["commands", "importers", "services"] });
  try {
    for (const transport of ["options", "global"] as const) {
      for (const args of [["--format", "mermaid"], ["--format", "json"]]) {
        const result = await harness.runCommand({ command: "pm-graph export", args, pmRoot: join(workspace, ".agents/pm"),
          options: transport === "options" ? { outputBudget: "unbounded" } : {},
          global: transport === "global" ? { outputBudget: "unbounded" } : {},
        });
        assert.equal(result.handled, true, result.errorMessage ?? "export must succeed");
        assert.equal((result.result as Record<string, unknown>).__pmGraphRawOutput, undefined);
      }
    }
    await assert.rejects(harness.runCommand({ command: "pm-graph export", args: ["--format", "mermaid", "--output", "refused.mmd"], pmRoot: join(workspace, ".agents/pm"), options: { outputBudget: "1000" } }), /cannot be combined/);
    for (const command of ["critical-path", "impact"]) {
      const result = await harness.runCommand({ command: `pm-graph ${command}`, args: [...(command === "impact" ? [ids[0]!] : []), "--format", "mermaid"], pmRoot: join(workspace, ".agents/pm"), options: { outputBudget: "unbounded" } });
      assert.equal(result.handled, true, result.errorMessage ?? "diagram must succeed");
    }
  } finally { await harness.deactivate(); }
});

/** Keep the cycle command's failure contract while preventing diagram leakage. */
test("cycle failures retain exit 1 without unbudgeted diagram stdout", () => {
  pm(["update", ids[0]!, "--blocked-by", ids[1]!]);
  const result = run(process.execPath, [cli, "--pm-path", ".agents/pm", "pm-graph", "cycles", "--format", "mermaid", "--output-budget", "1000"]);
  assert.equal(result.status, 1);
  // renderMermaid emits `graph TD`, so reject that exact header: an unbudgeted
  // diagram printed by the cycle handler must fail this assertion.
  assert.doesNotMatch(result.stdout, /graph TD/);
  assert.match(result.stdout + result.stderr, /dependency cycle/);
});

/**
 * The analyze and explain commands return `cycles` collections; the read_output
 * contract must declare them so amount controls and budget continuations treat
 * each cycle as an independently resumable row.
 */
test("analyze and explain declare nonempty cycles rows for amount controls and budget continuation", async () => {
  // Fresh hub and partner items carry no structural chain edges, so every new
  // cycle row is a small, uniform [hub, partner, hub] path; the analyze
  // collection additionally keeps the ids[0] <-> ids[1] cycle from the
  // preceding test. Both collections therefore span several short rows.
  const client = new PmClient({ pmRoot: join(workspace, ".agents/pm"), author: "contract-test", noExtensions: true });
  const hubItem = await client.create({ type: "Task", title: "Synthetic cycles hub", createMode: "progressive" });
  const partnerIds: string[] = [];
  for (let index = 0; index < 20; index++) {
    const partner = await client.create({ type: "Task", title: `Synthetic cycles partner ${index}`, createMode: "progressive" });
    partnerIds.push(partner.item.id);
  }
  for (const partnerId of partnerIds) {
    await client.update(hubItem.item.id, { blockedBy: partnerId });
    await client.update(partnerId, { blockedBy: hubItem.item.id });
  }
  const hub = hubItem.item.id;
  for (const scenario of [
    { name: "pm-graph analyze", args: ["pm-graph", "analyze"] },
    { name: "pm-graph explain", args: ["pm-graph", "explain", hub] },
  ]) {
    const full = pm([...scenario.args, "--output-budget", "unbounded", "--output-limit", "unbounded", "--output-row-contract"]);
    const expected = rows(full, "cycles");
    assert.ok(expected.length >= 3, `${scenario.name}: fixture must return several cycle rows`);
    const contract = full.row_contract as { row_keys: string[] } | undefined;
    assert.ok(contract?.row_keys?.includes("cycles"), `${scenario.name}: cycles must be declared as rows`);
    // Amount control: --output-limit bounds the declared cycles rows.
    const limited = pm([...scenario.args, "--output-include", "cycles", "--output-limit", "2", "--output-budget", "unbounded"]);
    assert.equal(rows(limited, "cycles").length, 2, `${scenario.name}: --output-limit must bound cycles rows`);
    const applied = limited.applied_bound as { kind: string; value: number } | undefined;
    assert.equal(applied?.kind, "output_limit", `${scenario.name}: amount truncation must be reported`);
    assert.equal(applied?.value, 2);
    // Cost control: find the first budget whose truncation offers a resumable
    // cycles cursor, so the collection demonstrably pages under a ceiling.
    const controls = ["--output-include", "cycles", "--output-limit", "unbounded"];
    let budget = 0;
    for (const candidate of [1600, 1400, 1200, 1000, 900, 800, 700, 600, 500, 400]) {
      const result = pm([...scenario.args, ...controls, "--output-budget", String(candidate)], [0, 2]);
      const truncation = result.output_budget_truncation as { compacted_row_paths?: string[]; continuations?: Array<{ path: string; cursor: string }> } | undefined;
      if (!result.output_budget_exceeded && truncation?.continuations?.some((entry) => entry.path === "cycles")) { budget = candidate; break; }
    }
    assert.ok(budget > 0, `${scenario.name}: fixture must exercise budget continuation on cycles`);
    // Resume pages through cursors until every row has returned once, in order.
    // A page whose rows were compacted internally (nested cycles.<n> paths) or
    // that exceeded the budget is refetched from the same cursor at a larger
    // budget, following the receipt's recovery guidance.
    const actual: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let raises = 0;
    for (;;) {
      const page = pm([...scenario.args, ...controls, "--output-budget", String(budget), ...(cursor ? ["--output-cursor", cursor] : [])], [0, 2]);
      const truncation = page.output_budget_truncation as { compacted_row_paths?: string[]; continuations?: Array<{ path: string; cursor: string }> } | undefined;
      const compactedRow = (truncation?.compacted_row_paths ?? []).some((rowPath) => /^cycles\.\d+$/.test(rowPath));
      if (page.output_budget_exceeded || compactedRow) {
        raises += 1;
        assert.ok(raises <= 10, `${scenario.name}: bounded recovery must converge`);
        budget *= 2;
        continue;
      }
      actual.push(...rows(page, "cycles"));
      const next = truncation?.continuations?.find((entry) => entry.path === "cycles");
      if (!next) break;
      assert.ok(!cursors.has(next.cursor), "continuation must advance");
      cursors.add(next.cursor);
      cursor = next.cursor;
    }
    assert.deepEqual(actual, expected, `${scenario.name}: every cycles row must return once, unchanged and in order`);
  }
});
