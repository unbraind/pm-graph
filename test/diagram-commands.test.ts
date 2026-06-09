import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import extension from "../dist/index.js";

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
  return JSON.parse(out).item.id as string;
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
