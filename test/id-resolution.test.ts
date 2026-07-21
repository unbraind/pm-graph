import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import extension from "../dist/index.js";

type Handler = (ctx: { cwd?: string; args?: string[] }) => Promise<unknown>;

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

function uniqueNonExactPrefix(id: string, allIds: string[]): string | null {
  for (let len = 1; len < id.length; len++) {
    const prefix = id.slice(0, len);
    const matches = allIds.filter((candidate) =>
      candidate.toLowerCase().startsWith(prefix.toLowerCase())
    );
    if (matches.length === 1) return prefix;
  }
  return null;
}

let pmAvailable = true;
try {
  execFileSync("pm", ["--version"], { encoding: "utf-8" });
} catch {
  pmAvailable = false;
}

test("path resolves source/target by unique prefix and case-insensitive id", { skip: !pmAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-id-path-"));
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    const b = createItem(ws, "Beta", a);
    const c = createItem(ws, "Gamma", b);

    const fromPrefix = uniqueNonExactPrefix(c, [a, b, c]);
    assert.ok(fromPrefix, "test setup expected a unique non-exact prefix");

    const handlers = collectHandlers();
    const run = handlers.get("pm-graph path");
    assert.ok(run, "path command should be registered");

    const result = await run!({ cwd: ws, args: [fromPrefix!, a.toUpperCase()] }) as {
      ok: boolean;
      from: string;
      to: string;
      found: boolean;
      path: string[] | null;
    };
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.from, c, "source resolved from unique prefix");
    assert.strictEqual(result.to, a, "target resolved from case-insensitive id");
    assert.strictEqual(result.found, true);
    assert.deepStrictEqual(result.path, [c, b, a]);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("path reports an ambiguous source id prefix", { skip: !pmAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-id-ambig-"));
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    createItem(ws, "Beta");

    const handlers = collectHandlers();
    const run = handlers.get("pm-graph path");
    assert.ok(run, "path command should be registered");

    await assert.rejects(
      () => run!({ cwd: ws, args: ["pm-", a] }),
      /Source item "pm-" is ambiguous/,
      "ambiguous prefixes should fail with a guidance error",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("impact resolves id by unique prefix", { skip: !pmAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-id-impact-"));
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    const b = createItem(ws, "Beta", a);
    const c = createItem(ws, "Gamma", b);

    const idPrefix = uniqueNonExactPrefix(a, [a, b, c]);
    assert.ok(idPrefix, "test setup expected a unique non-exact prefix");

    const handlers = collectHandlers();
    const run = handlers.get("pm-graph impact");
    assert.ok(run, "impact command should be registered");

    const result = await run!({ cwd: ws, args: [idPrefix!] }) as {
      ok: boolean;
      id: string;
      count: number;
      impacted: string[];
    };
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.id, a, "id resolves from unique prefix");
    assert.strictEqual(result.count, 2);
    assert.deepStrictEqual([...result.impacted].sort(), [b, c].sort());
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("analytics --root not-found includes item suggestions", { skip: !pmAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-id-root-"));
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");

    const handlers = collectHandlers();
    const run = handlers.get("pm-graph analyze");
    assert.ok(run, "analyze command should be registered");

    await assert.rejects(
      () => run!({ cwd: ws, args: ["--root", `${a}-typo`] }),
      /Did you mean:/,
      "unknown --root values should return suggestion hints",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
