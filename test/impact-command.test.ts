import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import extension from "../dist/index.js";

// Integration tests that drive the REAL registered `pm-graph impact` handler
// against a throwaway pm workspace, exercising the full path: flag parsing ->
// graph load via `pm list-all` -> canonical `pm graph impact` delegation (or
// legacy fallback) -> result shaping / diagram rendering. Mirrors the
// diagram-commands.test.ts / explain-command.test.ts harness style.

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

// Detect the canonical `pm graph impact` engine so upstream/both assertions
// can skip gracefully on older pm-cli (the command itself falls back).
let pmGraphImpactAvailable = false;
if (pmAvailable) {
  try {
    const help = execFileSync("pm", ["graph", "--help"], { encoding: "utf-8" });
    pmGraphImpactAvailable = /\bimpact\b/.test(help);
  } catch {
    pmGraphImpactAvailable = false;
  }
}

test("impact returns downstream dependents with affected distance/path rows (canonical engine)", { skip: !pmAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-impact-"));
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    const b = createItem(ws, "Beta", a);
    const c = createItem(ws, "Gamma", b);

    const handlers = collectHandlers();
    const run = handlers.get("pm-graph impact");
    assert.ok(run, "impact command should be registered");

    const result = (await run!({ cwd: ws, args: [a, "--json"] })) as {
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
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-impact-bc-"));
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    const b = createItem(ws, "Beta", a);
    createItem(ws, "Gamma", b);

    const handlers = collectHandlers();
    const run = handlers.get("pm-graph impact")!;
    const result = (await run!({ cwd: ws, args: [a, "--direction", "downstream", "--format", "json"] })) as any;
    // Core back-compat fields keep their shape and meaning.
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.id, a);
    assert.strictEqual(result.count, result.impacted.length);
    assert.ok(Array.isArray(result.impacted) && result.impacted.every((id: string) => typeof id === "string"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("impact --format mermaid prints a diagram containing the root and affected node ids", { skip: !pmAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-impact-mermaid-"));
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    const b = createItem(ws, "Beta", a);
    const c = createItem(ws, "Gamma", b);

    const handlers = collectHandlers();
    const run = handlers.get("pm-graph impact")!;
    const { result, stdout } = await captureStdout(() => run!({ cwd: ws, args: [a, "--format", "mermaid"] }));
    assert.ok(stdout.startsWith("graph TD"), "mermaid diagram printed on stdout");
    for (const id of [a, b, c]) {
      assert.ok(stdout.includes(`n_${id.replace(/[^A-Za-z0-9_]/g, "_")}[`), `impact node ${id} present in mermaid`);
    }
    assert.strictEqual((result as any).format, "mermaid");
    assert.ok(typeof (result as any).diagram === "string", "diagram field populated");
    assert.strictEqual((result as any).engine, "core-graph");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("impact --direction upstream reaches prerequisites (canonical engine)", { skip: !pmAvailable || !pmGraphImpactAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-impact-up-"));
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    const b = createItem(ws, "Beta", a);
    const c = createItem(ws, "Gamma", b);

    const handlers = collectHandlers();
    const run = handlers.get("pm-graph impact")!;
    const result = (await run!({ cwd: ws, args: [c, "--direction", "upstream", "--json"] })) as any;
    assert.strictEqual(result.direction, "upstream");
    assert.strictEqual(result.engine, "core-graph");
    // Upstream of C = its blockers A and B, sorted.
    assert.deepStrictEqual(result.impacted, [a, b].sort());
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("impact --depth caps the traversal depth", { skip: !pmAvailable || !pmGraphImpactAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-impact-depth-"));
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    const b = createItem(ws, "Beta", a);
    createItem(ws, "Gamma", b);

    const handlers = collectHandlers();
    const run = handlers.get("pm-graph impact")!;
    const result = (await run!({ cwd: ws, args: [a, "--depth", "1", "--json"] })) as any;
    // depth 1 from A: only the immediate dependent B (not the depth-2 C).
    assert.deepStrictEqual(result.impacted, [b]);
    assert.strictEqual(result.truncated, true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("impact validates missing positional id", { skip: !pmAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-impact-usage-"));
  try {
    pm(ws, ["init"]);
    const handlers = collectHandlers();
    const run = handlers.get("pm-graph impact");
    assert.ok(run, "impact command should be registered");
    await assert.rejects(
      () => run!({ cwd: ws, args: [] }),
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
      () => run!({ cwd: ws, args: [a, "--direction", "sideways"] }),
      /Invalid --direction "sideways"/,
      "unknown direction is rejected with a USAGE error",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});