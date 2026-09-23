import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { captureStdout, captureStdoutThrow, collectHandlers, createItem, pm, pmAvailable, setupBareWorkspace, setupChainWorkspace, setupCycleWorkspace, type Handler } from "./helpers.ts";

/** Run a cycles --format command, assert it throws and returns captured stdout. */
async function assertCycleFormatThrows(run: Handler, ws: string, format: string): Promise<string> {
  const outcome = await captureStdoutThrow(() => run({ cwd: ws, args: ["--format", format] }));
  assert.notStrictEqual(outcome.error, undefined, "cycles still exits non-zero (CI-gating preserved)");
  assert.match(
    String(outcome.error instanceof Error ? outcome.error.message : outcome.error),
    /dependency cycle/i,
    "still reports the cycle",
  );
  return outcome.stdout;
}

// Integration tests that drive the REAL registered command handlers
// (critical-path / cycles) against a throwaway pm workspace, so we exercise the
// full path: flag parsing -> graph load via `pm list-all` -> subgraph -> render.
// These verify the --format wiring end-to-end and that the text default is
// unchanged. The deterministic subgraph/renderer assertions live in
// analytics.test.ts; here we confirm the command surface.

test("critical-path --format mermaid prints a diagram and keeps the result object", { skip: !pmAvailable }, async () => {
  const { ws, a, b, c, run } = setupChainWorkspace("pmg-cp-", "pm-graph critical-path");
  try {
    // text default: byte-identical to the no-flag result, no stdout diagram.
    const baseline = await captureStdout(() => run({ cwd: ws, args: [] }));
    const explicitText = await captureStdout(() => run({ cwd: ws, args: ["--format", "text"] }));
    assert.deepStrictEqual(explicitText.result, baseline.result, "--format text === no --format");
    assert.strictEqual(baseline.stdout, "", "text default prints no diagram");
    const chain = (baseline.result as { path: string[] }).path;
    assert.deepStrictEqual(chain, [c, b, a], "chain is the full dependency chain");

    // mermaid: prints a mermaid diagram containing exactly the chain nodes.
    const mermaid = await captureStdout(() => run({ cwd: ws, args: ["--format", "mermaid"] }));
    assert.ok(mermaid.stdout.startsWith("graph TD"), "mermaid diagram printed");
    for (const id of chain) {
      assert.ok(mermaid.stdout.includes(`n_${id.replace(/[^A-Za-z0-9_]/g, "_")}[`), `chain node ${id} present`);
    }
    assert.strictEqual((mermaid.result as { format: string }).format, "mermaid");
    assert.deepStrictEqual((mermaid.result as { path: string[] }).path, chain, "path unchanged under mermaid");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("cycles --format graphml prints the cycle subgraph then exits non-zero", { skip: !pmAvailable }, async () => {
  const { ws, x, y, run } = setupCycleWorkspace("pmg-cy-");
  try {
    const captured = await assertCycleFormatThrows(run, ws, "graphml");
    assert.ok(captured.startsWith('<?xml version="1.0"'), "GraphML diagram printed before throwing");
    assert.ok(captured.includes(`<node id="${x}">`) && captured.includes(`<node id="${y}">`), "both cycle nodes present");
    const edgeCount = (captured.match(/<edge /g) ?? []).length;
    assert.strictEqual(edgeCount, 2, "exactly the two cycle edges");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("critical-path rejects an invalid --format value cleanly", { skip: !pmAvailable }, async () => {
  const { ws, run } = setupBareWorkspace("pmg-bad-", "pm-graph critical-path");
  try {
    await assert.rejects(
      () => run({ cwd: ws, args: ["--format", "svg"] }),
      /Invalid --format "svg"/,
      "invalid format is rejected with a USAGE error before any graph load",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("critical-path --format dot prints a Graphviz digraph and keeps the result object", { skip: !pmAvailable }, async () => {
  const { ws, a, b, c, run } = setupChainWorkspace("pmg-dot-", "pm-graph critical-path");
  try {
    const chain = (await run({ cwd: ws, args: [] }) as { path: string[] }).path;
    assert.deepStrictEqual(chain, [c, b, a], "baseline chain is the full dependency chain");

    const dot = await captureStdout(() => run({ cwd: ws, args: ["--format", "dot"] }));
    assert.ok(dot.stdout.startsWith("digraph pm_graph {"), "Graphviz digraph printed");
    assert.ok(dot.stdout.trim().endsWith("}"), "digraph closes");
    for (const id of chain) {
      assert.ok(dot.stdout.includes(`"${id}" [label=`), `chain node ${id} present in dot`);
    }
    assert.strictEqual((dot.result as { format: string }).format, "dot");
    assert.deepStrictEqual((dot.result as { path: string[] }).path, chain, "path unchanged under dot");
    assert.ok((dot.result as { diagram: string }).diagram, "diagram field populated");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("cycles --format dot prints the cycle subgraph then exits non-zero", { skip: !pmAvailable }, async () => {
  const { ws, x, y, run } = setupCycleWorkspace("pmg-cydot-");
  try {
    const captured = await assertCycleFormatThrows(run, ws, "dot");
    assert.ok(captured.startsWith("digraph pm_graph {"), "Graphviz digraph printed before throwing");
    assert.ok(captured.includes(`"${x}"`) && captured.includes(`"${y}"`), "both cycle nodes present");
    const edgeCount = (captured.match(/->/g) ?? []).length;
    assert.strictEqual(edgeCount, 2, "exactly the two cycle edges");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("analyze --filter type=... scopes the report to matching item types", { skip: !pmAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-ftype-"));
  try {
    pm(ws, ["init"]);
    const t1 = createItem(ws, "Task One");
    createItem(ws, "Task Two", t1);
    pm(ws, ["create", "Epic", "Epic One", "--json"]); // an Epic, not a Task
    const handlers = collectHandlers();
    const run = handlers.get("pm-graph analyze")!;

    const all = (await run({ cwd: ws, args: [] })) as { ok: boolean; itemCount: number };
    assert.strictEqual(all.itemCount, 3, "three items total (2 Tasks + 1 Epic)");

    const filtered = (await run({ cwd: ws, args: ["--filter", "type=Task"] })) as { ok: boolean; itemCount: number };
    assert.strictEqual(filtered.itemCount, 2, "only the two Task items survive --filter type=Task");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("analyze --filter status=... scopes the report and AND-combines with type", { skip: !pmAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-fstat-"));
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    const b = createItem(ws, "Beta", a);
    // close Beta so it is excluded by default but retained with --include-closed.
    pm(ws, ["close", b, "done"]);
    const handlers = collectHandlers();
    const run = handlers.get("pm-graph analyze")!;

    // default: closed Beta dropped, only Alpha remains.
    const baseline = (await run({ cwd: ws, args: [] })) as { ok: boolean; itemCount: number };
    assert.strictEqual(baseline.itemCount, 1, "closed item excluded by default");

    // --include-closed: both items present.
    const withClosed = (await run({ cwd: ws, args: ["--include-closed"] })) as { ok: boolean; itemCount: number };
    assert.strictEqual(withClosed.itemCount, 2, "closed item retained with --include-closed");

    // --filter status=open AND --include-closed: closed Beta is retained by
    // --include-closed but then dropped by the status filter, leaving Alpha only.
    const statusFiltered = (await run({ cwd: ws, args: ["--include-closed", "--filter", "status=open"] })) as {
      ok: boolean;
      itemCount: number;
    };
    assert.strictEqual(statusFiltered.itemCount, 1, "status filter drops the closed item even with --include-closed");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("critical-path --filter rejects a malformed filter with a USAGE error", { skip: !pmAvailable }, async () => {
  const { ws, run } = setupBareWorkspace("pmg-badfilt-", "pm-graph critical-path");
  try {
    await assert.rejects(
      () => run({ cwd: ws, args: ["--filter", "priority=high"] }),
      /Invalid --filter key "priority"/,
      "unsupported filter key is rejected with a USAGE error",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
