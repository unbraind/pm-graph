import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { collectHandlers, createItem, pm, pmAvailable } from "./helpers.ts";

type ExplainResult = {
  ok: boolean;
  id: string;
  blockers: Array<{ id: string; relationTypes: string[] }>;
  dependents: Array<{ id: string; relationTypes: string[] }>;
  transitiveDependents: string[];
  dependencyDepth: number;
  criticalChainFromItem: string[];
  inCycle: boolean;
  cycleCount: number;
};

test("explain command returns blockers, dependents, and chain from one item", { skip: !pmAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-explain-"));
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    const b = createItem(ws, "Beta", a);
    const c = createItem(ws, "Gamma", b);

    const handlers = collectHandlers();
    const run = handlers.get("pm-graph explain");
    assert.ok(run, "explain command should be registered");

    const result = await run!({ cwd: ws, args: [b] }) as ExplainResult;
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.id, b);
    assert.deepStrictEqual(result.blockers.map((n) => n.id), [a]);
    assert.deepStrictEqual(result.dependents.map((n) => n.id), [c]);
    assert.deepStrictEqual(result.transitiveDependents, [c]);
    assert.strictEqual(result.dependencyDepth, 1);
    assert.deepStrictEqual(result.criticalChainFromItem, [b, a]);
    assert.strictEqual(result.inCycle, false);
    assert.strictEqual(result.cycleCount, 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("explain command errors on missing id with suggestions", { skip: !pmAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-explain-miss-"));
  try {
    pm(ws, ["init"]);
    const existing = createItem(ws, "Target");

    const handlers = collectHandlers();
    const run = handlers.get("pm-graph explain");
    assert.ok(run, "explain command should be registered");

    await assert.rejects(
      () => run!({ cwd: ws, args: [`${existing}-typo`] }),
      /Did you mean:/,
      "unknown ids should include suggestion hints when possible",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("explain command validates missing positional id", { skip: !pmAvailable }, async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pmg-explain-usage-"));
  try {
    pm(ws, ["init"]);
    const handlers = collectHandlers();
    const run = handlers.get("pm-graph explain");
    assert.ok(run, "explain command should be registered");

    await assert.rejects(
      () => run!({ cwd: ws, args: [] }),
      /Usage: pm pm-graph explain <id>/,
      "missing id should return a usage error",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
