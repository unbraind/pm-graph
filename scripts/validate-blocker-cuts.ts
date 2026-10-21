/** Replay every goal in a public tracker copy, emitting aggregate receipts only. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { listAllComplete, readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { graphFromItems, minimalBlockerCuts } from "../src/index.ts";
import type { BlockerCutOptions } from "../src/index.ts";

/** Fingerprint input records and settings without including mutable SDK caches. */
function fingerprint(root: string): string {
  const hash = createHash("sha256");
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(relative, entry.name);
      if (entry.isDirectory() && !["runtime", "locks", "transactions", "search", "extensions"].includes(entry.name)) walk(name);
      else if (entry.isFile() && /\.(?:toon|jsonl|json)$/.test(name)) hash.update(name).update(readFileSync(join(root, name)));
    }
  };
  walk("");
  return hash.digest("hex");
}

/** Validate source immutability, result budgets and complete source receipts for every item. */
export async function validateBlockerCuts(root: string): Promise<Record<string, unknown>> {
  const before = fingerprint(root);
  const started = performance.now();
  const snapshot = await listAllComplete({}, { pmRoot: root, noExtensions: true });
  const graph = graphFromItems(snapshot.items, ".", new Map());
  const registry = resolveRuntimeStatusRegistry((await readSettings(root)).schema);
  const options: BlockerCutOptions = {
    resolvedStatuses: [...registry.terminal_statuses],
    unresolvedStatuses: [...registry.by_id.keys()].filter((id) => !registry.terminal_statuses.has(id)),
  };
  const refusals: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  let cuts = 0;
  let maxStates = 0;
  let maxWork = 0;
  let nonemptyGoals = 0;
  const sizes: number[] = [];
  for (const item of snapshot.items) {
    const result = minimalBlockerCuts(graph, item.id, options);
    sizes.push(Buffer.byteLength(JSON.stringify(result)));
    assert.ok(result.receipt.search.states <= result.receipt.search.limits.maxStates);
    assert.ok(result.receipt.search.work <= result.receipt.search.limits.maxWork);
    maxStates = Math.max(maxStates, result.receipt.search.states);
    maxWork = Math.max(maxWork, result.receipt.search.work);
    if (!result.ok) refusals[result.refusal.code] = (refusals[result.refusal.code] ?? 0) + 1;
    else {
      reasons[result.receipt.search.reason] = (reasons[result.receipt.search.reason] ?? 0) + 1;
      cuts += result.cuts.length;
      if (result.cuts.some((cut) => cut.blockers.length)) nonemptyGoals++;
    }
  }
  assert.equal(fingerprint(root), before, "tracker input records must remain byte-identical");
  sizes.sort((a, b) => a - b);
  return {
    source: snapshot.complete_list, nodes: graph.nodes.length, relationships: graph.relationships.length,
    goals: snapshot.items.length, nonemptyGoals, cuts, refusals, searchReasons: reasons, maxStates, maxWork,
    jsonBytes: { median: sizes[Math.floor(sizes.length / 2)] ?? 0, max: sizes.at(-1) ?? 0 },
    elapsedMs: Math.round((performance.now() - started) * 100) / 100, inputUnchanged: true,
  };
}

// This is an explicit local validation script; it never fetches or mutates a tracker.
if (process.argv[1]?.endsWith("validate-blocker-cuts.ts")) {
  const root = process.argv[2];
  if (!root) throw new Error("Supply a read-only public tracker copy as the sole argument.");
  console.log(JSON.stringify(await validateBlockerCuts(root), null, 2));
}
