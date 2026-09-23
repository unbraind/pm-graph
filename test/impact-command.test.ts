import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { captureStdout, collectHandlers, createItem, pm, pmAvailable, setupBareWorkspace, setupChainWorkspace } from "./helpers.ts";

// Integration tests that drive the REAL registered `pm-graph impact` handler
// against a throwaway pm workspace, exercising the full path: flag parsing ->
// graph load via `pm list-all` -> canonical `pm graph impact` delegation (or
// legacy fallback) -> result shaping / diagram rendering. Mirrors the
// diagram-commands.test.ts / explain-command.test.ts harness style.

type ImpactResult = {
  ok: boolean;
  id: string;
  count: number;
  impacted: string[];
  direction?: string;
  affected?: Array<{ id: string; distance: number; path: string[] }>;
  truncated?: boolean;
  engine: string;
  format?: string;
  diagram?: string;
};

let pmGraphImpactAvailable = false;
if (pmAvailable) {
  try {
    const help = execFileSync("pm", ["graph", "--help"], { encoding: "utf-8" });
    pmGraphImpactAvailable = /\bimpact\b/.test(help);
  } catch {
    pmGraphImpactAvailable = false;
  }
}

test("impact returns downstream dependents with affected distance/path rows (canonical engine)", { skip: !pmAvailable || !pmGraphImpactAvailable }, async () => {
  const { ws, a, b, c, run } = setupChainWorkspace("pmg-impact-", "pm-graph impact");
  try {
    const result = (await run({ cwd: ws, args: [a, "--json"] })) as {
      ok: boolean;
      id: string;
      count: number;
      impacted: string[];
      direction: string;
      affected: Array<{ id: string; distance: number; path: string[] }>;
      truncated: boolean;
      engine: string;
    };
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.id, a);
    assert.strictEqual(result.engine, "core-graph");
    assert.strictEqual(result.direction, "downstream");
    // impacted must contain both downstream dependents, sorted.
    assert.deepStrictEqual(result.impacted, [b, c].sort());
    assert.strictEqual(result.count, 2);
    // Each affected row carries distance and a path anchored at the root.
    assert.strictEqual(result.affected.length, 2);
    const byId = new Map(result.affected.map((r) => [r.id, r]));
    assert.strictEqual(byId.get(b)!.distance, 1);
    assert.deepStrictEqual(byId.get(b)!.path[0], a);
    assert.strictEqual(byId.get(c)!.distance, 2);
    assert.deepStrictEqual(byId.get(c)!.path[0], a);
    assert.strictEqual(typeof result.truncated, "boolean");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("impact back-compat shape is preserved for --format json --direction downstream", { skip: !pmAvailable }, async () => {
  const { ws, a, run } = setupChainWorkspace("pmg-impact-bc-", "pm-graph impact");
  try {
    const result = (await run({ cwd: ws, args: [a, "--direction", "downstream", "--format", "json"] })) as ImpactResult;
    // Core back-compat fields keep their shape and meaning.
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.id, a);
    assert.strictEqual(result.count, result.impacted.length);
    assert.ok(Array.isArray(result.impacted) && result.impacted.every((id: string) => typeof id === "string"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("impact --filter restricts the canonical result set (post-filter engine parity)", { skip: !pmAvailable || !pmGraphImpactAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-impact-filter-"));
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    const b = createItem(ws, "BetaTask", a); // Task dependent of A
    // Gamma is an Issue directly blocked-by A, so both B and C are direct
    // dependents of A but of different types.
    const gout = pm(ws, ["create", "Issue", "GammaIssue", "--blocked-by", a, "--json"]);
    const parsed = JSON.parse(gout) as { id?: string; item?: { id: string } };
    const c = (parsed.item?.id ?? parsed.id) as string;

    const handlers = collectHandlers();
    const run = handlers.get("pm-graph impact")!;

    // Unfiltered: both direct dependents are impacted, via the canonical engine.
    const all = (await run({ cwd: ws, args: [a, "--format", "json"] })) as ImpactResult;
    assert.ok(all.impacted.includes(b) && all.impacted.includes(c), "both dependents present unfiltered");
    assert.strictEqual(all.engine, "core-graph");

    // --filter type=task post-filters the canonical affected set to Tasks only,
    // proving the presentation flags now apply on the canonical path (previously
    // they were silently ignored there).
    const filtered = (await run({ cwd: ws, args: [a, "--filter", "type=task", "--format", "json"] })) as ImpactResult;
    assert.ok(filtered.impacted.includes(b), "Task dependent kept under --filter type=task");
    assert.ok(!filtered.impacted.includes(c), "Issue dependent removed under --filter type=task");
    assert.strictEqual(filtered.count, filtered.impacted.length, "count === impacted.length under filter");
    assert.strictEqual(filtered.engine, "core-graph", "canonical engine used; filter applied via post-filter");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("impact --filter drops endpoints reachable only through a filtered-out intermediary (traversal parity)", { skip: !pmAvailable || !pmGraphImpactAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-impact-inter-"));
  try {
    pm(ws, ["init"]);
    // Chain A <- B <- C: A is a Task, B (the intermediary) is an Issue, C is a Task.
    const a = createItem(ws, "AlphaTask");
    const bout = pm(ws, ["create", "Issue", "BetaIssue", "--blocked-by", a, "--json"]);
    const bParsed = JSON.parse(bout) as { id?: string; item?: { id: string } };
    const b = (bParsed.item?.id ?? bParsed.id) as string;
    const c = createItem(ws, "CharlieTask", b);

    const handlers = collectHandlers();
    const run = handlers.get("pm-graph impact")!;

    // Unfiltered downstream impact of A includes B and the transitive C.
    const all = (await run({ cwd: ws, args: [a, "--format", "json"] })) as ImpactResult;
    assert.ok(all.impacted.includes(b) && all.impacted.includes(c), "B and transitive C impacted unfiltered");

    // --filter type=task removes the Issue intermediary B. The fallback removes
    // B's edges with it, so C — reachable from A only through B — is NOT impacted
    // even though C itself is a Task. The canonical path validates each row's
    // full explaining path against the shaped set to reproduce this exactly, so
    // both engines agree that only-through-a-filtered-node endpoints drop out.
    const filtered = (await run({ cwd: ws, args: [a, "--filter", "type=task", "--format", "json"] })) as ImpactResult;
    assert.ok(!filtered.impacted.includes(b), "filtered-out Issue intermediary B absent");
    assert.ok(!filtered.impacted.includes(c), "Task C reachable only via filtered B is not impacted");
    assert.strictEqual(filtered.count, filtered.impacted.length, "count === impacted.length");
    assert.strictEqual(filtered.engine, "core-graph");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("impact --include-closed routes to the shaped-graph fallback and rejects non-downstream", { skip: !pmAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-impact-incl-"));
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    createItem(ws, "Beta", a);

    const handlers = collectHandlers();
    const run = handlers.get("pm-graph impact")!;

    // --include-closed cannot be honored by the canonical engine (active-only,
    // no closed switch), so it is routed to the shaped-graph fallback.
    const inc = (await run({ cwd: ws, args: [a, "--include-closed", "--format", "json"] })) as ImpactResult;
    assert.strictEqual(inc.engine, "fallback", "--include-closed routes to the shaped-graph fallback");
    assert.strictEqual(inc.count, inc.impacted.length, "count === impacted.length (--include-closed fallback)");

    // The fallback expresses only downstream; upstream/both must fail loudly
    // with an accurate reason (not the older-pm-cli message).
    await assert.rejects(
      () => run({ cwd: ws, args: [a, "--include-closed", "--direction", "upstream"] }) as Promise<unknown>,
      /include-closed[\s\S]*downstream/i,
      "--include-closed + upstream rejected with a clear message",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("impact --format mermaid prints a diagram containing the root and affected node ids", { skip: !pmAvailable || !pmGraphImpactAvailable }, async () => {
  const { ws, a, b, c, run } = setupChainWorkspace("pmg-impact-mermaid-", "pm-graph impact");
  try {
    const { result, stdout } = await captureStdout(() => run({ cwd: ws, args: [a, "--format", "mermaid"] }));
    assert.ok(stdout.startsWith("graph TD"), "mermaid diagram printed on stdout");
    for (const id of [a, b, c]) {
      assert.ok(stdout.includes(`n_${id.replace(/[^A-Za-z0-9_]/g, "_")}[`), `impact node ${id} present in mermaid`);
    }
    assert.strictEqual((result as ImpactResult).format, "mermaid");
    assert.ok(typeof (result as ImpactResult).diagram === "string", "diagram field populated");
    assert.strictEqual((result as ImpactResult).engine, "core-graph");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("impact --direction upstream reaches prerequisites (canonical engine)", { skip: !pmAvailable || !pmGraphImpactAvailable }, async () => {
  const { ws, a, b, c, run } = setupChainWorkspace("pmg-impact-up-", "pm-graph impact");
  try {
    const result = (await run({ cwd: ws, args: [c, "--direction", "upstream", "--json"] })) as ImpactResult;
    assert.strictEqual(result.direction, "upstream");
    assert.strictEqual(result.engine, "core-graph");
    // Upstream of C = its blockers A and B, sorted.
    assert.deepStrictEqual(result.impacted, [a, b].sort());
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("impact --depth caps the traversal depth", { skip: !pmAvailable || !pmGraphImpactAvailable }, async () => {
  const { ws, a, b, run } = setupChainWorkspace("pmg-impact-depth-", "pm-graph impact");
  try {
    const result = (await run({ cwd: ws, args: [a, "--depth", "1", "--json"] })) as ImpactResult;
    // depth 1 from A: only the immediate dependent B (not the depth-2 C).
    assert.deepStrictEqual(result.impacted, [b]);
    assert.strictEqual(result.truncated, true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("impact validates missing positional id", { skip: !pmAvailable }, async () => {
  const { ws, run } = setupBareWorkspace("pmg-impact-usage-", "pm-graph impact");
  try {
    await assert.rejects(
      () => run({ cwd: ws, args: [] }),
      /Usage: pm pm-graph impact <id>/,
      "missing id should return a usage error",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("impact rejects an invalid --direction value", { skip: !pmAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-impact-baddir-"));
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    const handlers = collectHandlers();
    const run = handlers.get("pm-graph impact")!;
    await assert.rejects(
      () => run({ cwd: ws, args: [a, "--direction", "sideways"] }),
      /Invalid --direction "sideways"/,
      "unknown direction is rejected with a USAGE error",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});