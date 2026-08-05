import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import extension from "../src/index.ts";

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

/**
 * Upper bound on setup attempts before the chain builder gives up.
 *
 * Each attempt fails independently with probability about 6.4e-5, so eight
 * attempts put a spurious failure below 1e-33 — far past the point where any
 * other source of flake dominates.
 */
const MAX_CHAIN_ATTEMPTS = 8;

/**
 * Builds a three-item blocked-by chain in a fresh workspace whose newest id is
 * addressable by a proper prefix, retrying until it is.
 *
 * Ids are `pm-` plus four random base36 characters, so the longest usable
 * proper prefix carries only three of them. Roughly once in 15,000 runs another
 * id in the workspace shares all three and no proper prefix of the newest id is
 * unique. That is a property of the randomly generated ids, **not** of the
 * resolution code under test, so it is a precondition to re-roll rather than an
 * assertion to fail on — asserting it turned a coin flip into a red build on
 * unrelated pull requests.
 *
 * Discards the workspace after a losing roll so each attempt starts from an
 * empty tracker; a retained one would add ids and make a collision more likely,
 * not less.
 *
 * @returns The workspace path, the three created ids oldest-first, and a prefix
 *   that resolves to `c` alone.
 */
function createChainWithUniquePrefix(): {
  ws: string;
  a: string;
  b: string;
  c: string;
  prefix: string;
} {
  let lastAttemptIds: string[] = [];
  for (let attempt = 0; attempt < MAX_CHAIN_ATTEMPTS; attempt++) {
    const ws = mkdtempSync(path.join(tmpdir(), "pmg-id-path-"));
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    const b = createItem(ws, "Beta", a);
    const c = createItem(ws, "Gamma", b);

    const prefix = uniqueNonExactPrefix(c, [a, b, c]);
    if (prefix) return { ws, a, b, c, prefix };

    rmSync(ws, { recursive: true, force: true });
    lastAttemptIds = [a, b, c];
  }
  throw new Error(
    `no unique non-exact prefix after ${MAX_CHAIN_ATTEMPTS} attempts; last ids: ${lastAttemptIds.join(", ")}`,
  );
}

test("path resolves source/target by unique prefix and case-insensitive id", { skip: !pmAvailable }, async () => {
  const { ws, a, b, c, prefix: fromPrefix } = createChainWithUniquePrefix();
  try {
    const handlers = collectHandlers();
    const run = handlers.get("pm-graph path");
    assert.ok(run, "path command should be registered");

    const result = await run!({ cwd: ws, args: [fromPrefix, a.toUpperCase()] }) as {
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
