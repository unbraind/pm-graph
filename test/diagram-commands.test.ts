import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import extension from "../src/index.ts";

// Integration tests that drive the REAL registered command handlers
// (critical-path / cycles) against a throwaway pm workspace, so we exercise the
// full path: flag parsing -> graph load via `pm list-all` -> subgraph -> render.
// These verify the --format wiring end-to-end and that the text default is
// unchanged. The deterministic subgraph/renderer assertions live in
// analytics.test.ts; here we confirm the command surface.

type Handler = (ctx: any) => Promise<unknown>;

function collectHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const api = {
    registerCommand: (cmd: { name: string; run: Handler }) => handlers.set(cmd.name, cmd.run),
    registerExporter: () => {},
    registerImporter: () => {},
    registerHook: () => {},
    registerSchema: () => {},
    registerRenderer: () => {},
    registerSearchProvider: () => {},
    registerPreflight: () => {},
    registerService: () => {},
  };
  extension.activate(api as any);
  return handlers;
}

function pm(cwd: string, args: string[]): string {
  return execFileSync("pm", args, { cwd, encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 });
}

function createItem(cwd: string, title: string, blockedBy?: string): string {
  const args = ["create", "Task", title, "--json"];
  if (blockedBy) args.push("--blocked-by", blockedBy);
  const out = pm(cwd, args);
  const created = JSON.parse(out) as { id?: string; item?: { id: string } };
  return (created.item?.id ?? created.id) as string;
}

/** Capture console.log output produced while running `fn`. */
async function captureStdout(fn: () => Promise<unknown>): Promise<{ result: unknown; stdout: string }> {
  const original = console.log;
  let buffer = "";
  console.log = (...parts: unknown[]) => {
    buffer += parts.map(String).join(" ") + "\n";
  };
  try {
    const result = await fn();
    return { result, stdout: buffer };
  } finally {
    console.log = original;
  }
}

let pmAvailable = true;
try {
  execFileSync("pm", ["--version"], { encoding: "utf-8" });
} catch {
  pmAvailable = false;
}

test("critical-path --format mermaid prints a diagram and keeps the result object", { skip: !pmAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-cp-"));
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    const b = createItem(ws, "Beta", a);
    const c = createItem(ws, "Gamma", b);
    const handlers = collectHandlers();
    const run = handlers.get("pm-graph critical-path")!;

    // text default: byte-identical to the no-flag result, no stdout diagram.
    const baseline = await captureStdout(() => run({ cwd: ws, args: [] }));
    const explicitText = await captureStdout(() => run({ cwd: ws, args: ["--format", "text"] }));
    assert.deepStrictEqual(explicitText.result, baseline.result, "--format text === no --format");
    assert.strictEqual(baseline.stdout, "", "text default prints no diagram");
    const chain = (baseline.result as any).path as string[];
    assert.deepStrictEqual(chain, [c, b, a], "chain is the full dependency chain");

    // mermaid: prints a mermaid diagram containing exactly the chain nodes.
    const mermaid = await captureStdout(() => run({ cwd: ws, args: ["--format", "mermaid"] }));
    assert.ok(mermaid.stdout.startsWith("graph TD"), "mermaid diagram printed");
    for (const id of chain) {
      assert.ok(mermaid.stdout.includes(`n_${id.replace(/[^A-Za-z0-9_]/g, "_")}[`), `chain node ${id} present`);
    }
    assert.strictEqual((mermaid.result as any).format, "mermaid");
    assert.deepStrictEqual((mermaid.result as any).path, chain, "path unchanged under mermaid");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("cycles --format graphml prints the cycle subgraph then exits non-zero", { skip: !pmAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-cy-"));
  try {
    pm(ws, ["init"]);
    // Build a real 2-node cycle: X blocked-by Y, then add Y blocked-by X.
    const x = createItem(ws, "X");
    const y = createItem(ws, "Y", x);
    pm(ws, ["update", x, "--blocked-by", y]);

    const handlers = collectHandlers();
    const run = handlers.get("pm-graph cycles")!;

    let threw = false;
    let captured = "";
    const original = console.log;
    console.log = (...parts: unknown[]) => { captured += parts.map(String).join(" ") + "\n"; };
    try {
      await run({ cwd: ws, args: ["--format", "graphml"] });
    } catch (err: any) {
      threw = true;
      assert.match(String(err?.message ?? err), /dependency cycle/i, "still reports the cycle");
    } finally {
      console.log = original;
    }
    assert.ok(threw, "cycles still exits non-zero (CI-gating preserved)");
    assert.ok(captured.startsWith('<?xml version="1.0"'), "GraphML diagram printed before throwing");
    assert.ok(captured.includes(`<node id="${x}">`) && captured.includes(`<node id="${y}">`), "both cycle nodes present");
    const edgeCount = (captured.match(/<edge /g) ?? []).length;
    assert.strictEqual(edgeCount, 2, "exactly the two cycle edges");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("critical-path rejects an invalid --format value cleanly", { skip: !pmAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-bad-"));
  try {
    pm(ws, ["init"]);
    const handlers = collectHandlers();
    const run = handlers.get("pm-graph critical-path")!;
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
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-dot-"));
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    const b = createItem(ws, "Beta", a);
    const c = createItem(ws, "Gamma", b);
    const handlers = collectHandlers();
    const run = handlers.get("pm-graph critical-path")!;

    const chain = (await run({ cwd: ws, args: [] }) as any).path as string[];
    assert.deepStrictEqual(chain, [c, b, a], "baseline chain is the full dependency chain");

    const dot = await captureStdout(() => run({ cwd: ws, args: ["--format", "dot"] }));
    assert.ok(dot.stdout.startsWith("digraph pm_graph {"), "Graphviz digraph printed");
    assert.ok(dot.stdout.trim().endsWith("}"), "digraph closes");
    for (const id of chain) {
      assert.ok(dot.stdout.includes(`"${id}" [label=`), `chain node ${id} present in dot`);
    }
    assert.strictEqual((dot.result as any).format, "dot");
    assert.deepStrictEqual((dot.result as any).path, chain, "path unchanged under dot");
    assert.ok((dot.result as any).diagram, "diagram field populated");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("cycles --format dot prints the cycle subgraph then exits non-zero", { skip: !pmAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-cydot-"));
  try {
    pm(ws, ["init"]);
    const x = createItem(ws, "X");
    const y = createItem(ws, "Y", x);
    pm(ws, ["update", x, "--blocked-by", y]);

    const handlers = collectHandlers();
    const run = handlers.get("pm-graph cycles")!;

    let threw = false;
    let captured = "";
    const original = console.log;
    console.log = (...parts: unknown[]) => { captured += parts.map(String).join(" ") + "\n"; };
    try {
      await run({ cwd: ws, args: ["--format", "dot"] });
    } catch (err: any) {
      threw = true;
      assert.match(String(err?.message ?? err), /dependency cycle/i, "still reports the cycle");
    } finally {
      console.log = original;
    }
    assert.ok(threw, "cycles still exits non-zero (CI-gating preserved)");
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
    const t2 = createItem(ws, "Task Two", t1);
    pm(ws, ["create", "Epic", "Epic One", "--json"]); // an Epic, not a Task
    const handlers = collectHandlers();
    const run = handlers.get("pm-graph analyze")!;

    const all = (await run({ cwd: ws, args: [] }) as any) as { itemCount: number };
    assert.strictEqual(all.itemCount, 3, "three items total (2 Tasks + 1 Epic)");

    const filtered = (await run({ cwd: ws, args: ["--filter", "type=Task"] }) as any) as { itemCount: number };
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
    const baseline = (await run({ cwd: ws, args: [] }) as any) as { itemCount: number };
    assert.strictEqual(baseline.itemCount, 1, "closed item excluded by default");

    // --include-closed: both items present.
    const withClosed = (await run({ cwd: ws, args: ["--include-closed"] }) as any) as { itemCount: number };
    assert.strictEqual(withClosed.itemCount, 2, "closed item retained with --include-closed");

    // --filter status=open AND --include-closed: closed Beta is retained by
    // --include-closed but then dropped by the status filter, leaving Alpha only.
    const statusFiltered = (await run({ cwd: ws, args: ["--include-closed", "--filter", "status=open"] }) as any) as {
      itemCount: number;
    };
    assert.strictEqual(statusFiltered.itemCount, 1, "status filter drops the closed item even with --include-closed");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("critical-path --filter rejects a malformed filter with a USAGE error", { skip: !pmAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-badfilt-"));
  try {
    pm(ws, ["init"]);
    const handlers = collectHandlers();
    const run = handlers.get("pm-graph critical-path")!;
    await assert.rejects(
      () => run({ cwd: ws, args: ["--filter", "priority=high"] }),
      /Invalid --filter key "priority"/,
      "unsupported filter key is rejected with a USAGE error",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
