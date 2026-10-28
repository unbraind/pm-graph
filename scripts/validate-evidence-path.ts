/** Aggregate-only public tracker validation: all tracker records remain byte-identical. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { evidencePathInputFromGraph, explainEvidencePath, graphFromItems } from "../src/index.ts";
import { fingerprint } from "./tracker-fingerprint.ts";
import { isMainInvocation } from "./main-invocation.ts";

/** Compare selected queries with an independent exact relaxation oracle on SDK-read data. */
export async function validateEvidencePaths(root: string): Promise<Record<string, unknown>> {
  const client = new PmClient({ pmRoot: root, noExtensions: true });
  const started = performance.now();
  const before = fingerprint(root);
  const snapshot = await client.listAllComplete();
  const graph = graphFromItems(snapshot.items, ".", new Map(), { includeFacets: false });
  const ids = snapshot.items.map((item) => item.id).sort();
  assert.ok(ids.length, "Supply a nonempty public tracker copy");
  const types = [...new Set(graph.relationships.map((edge) => edge.type))];
  if (!types.length) types.push("BLOCKED_BY");
  // Synthetic caller declarations only: no title/body length or private source reads.
  const costs = ids.map((id, i) => ({ id, cost: (i * 7919) % 997 }));
  const costFor = new Map(costs.map((row) => [row.id, row.cost]));
  let questions = 0; let reachable = 0; let proved = 0; let cheaper = 0; let longer = 0;
  let unknown = 0; let limited = 0; let maxWork = 0;
  const bytes: number[] = [];
  for (const from of ids.slice(0, 32)) {
    const best = new Map([[from, costFor.get(from)!]]);
    // Exact Bellman relaxation is deliberately independent of the production heap.
    for (let pass = 0; pass < ids.length; pass++) {
      let changed = false;
      for (const edge of graph.relationships) {
        if (!best.has(edge.from) || !costFor.has(edge.to)) continue;
        const candidate = best.get(edge.from)! + costFor.get(edge.to)!;
        if (!best.has(edge.to) || candidate < best.get(edge.to)!) { best.set(edge.to, candidate); changed = true; }
      }
      if (!changed) break;
    }
    const targets = [...new Set([...best.keys(), ...ids])].slice(0, 8);
    for (const to of targets) {
      const input = evidencePathInputFromGraph(graph, { from, to, edgeTypes: types, costs, maxPathNodes: 1000, maxWork: 1000000 });
      const result = explainEvidencePath(input); assert.ok(result.ok, JSON.stringify(result));
      questions++; bytes.push(Buffer.byteLength(JSON.stringify(result)));
      assert.equal(result.reachable, best.has(to));
      if (result.reachable) {
        reachable++; assert.equal(result.optimality, "proved"); proved++;
        assert.equal(result.rows[0].cost, best.get(to));
        if (result.rows[0].cost! < result.rows[1].cost!) {
          cheaper++;
          if (result.rows[0].hops > result.rows[1].hops) longer++;
        }
        for (const row of result.rows) for (let i = 1; i < row.path.length; i++)
          assert.ok(graph.relationships.some((edge) => edge.from === row.path[i - 1] && edge.to === row.path[i] && edge.type === row.edges[i - 1]));
      }
      maxWork = Math.max(maxWork, result.receipt.known.work, result.receipt.optimistic.work);
      const missing = explainEvidencePath({ ...input, costs: [] }); assert.ok(missing.ok);
      if (missing.reachable) { assert.equal(missing.optimality, "unknown-costs"); assert.equal(missing.rows[0].cost, null); unknown++; }
      const bounded = explainEvidencePath({ ...input, maxWork: 1 }); assert.ok(bounded.ok);
      assert.ok(bounded.receipt.known.work <= 1 && bounded.receipt.optimistic.work <= 1);
      if (bounded.optimality === "search-limited") limited++;
    }
  }
  assert.equal(fingerprint(root), before, "Tracker items/settings/history must remain byte-identical");
  bytes.sort((a, b) => a - b);
  const elapsedMs = Number((performance.now() - started).toFixed(2));
  return { inputUnchanged: true, elapsedMs, sourceItems: snapshot.items.length, sourceComplete: snapshot.complete_list.source_complete,
    nodes: graph.nodes.length, edges: graph.relationships.length, questions, reachable, proved,
    cheaperWitnesses: cheaper, longerCheaperWitnesses: longer, unknownCostReceipts: unknown, limitedSearchReceipts: limited, maxWork,
    fullGraphJsonBytes: Buffer.byteLength(JSON.stringify(graph)), medianJsonBytes: bytes[Math.floor(bytes.length / 2)], maxJsonBytes: bytes.at(-1) };
}

/** Print aggregate measurements only, never tracker identities or local topology. */
export async function main(args: readonly string[]): Promise<void> {
  if (args.length !== 1) throw new Error("Supply one read-only public tracker copy in a non-git directory.");
  const report = await validateEvidencePaths(args[0]);
  console.log(JSON.stringify(report, null, 2));
}

if (isMainInvocation(process.argv, import.meta.url)) await main(process.argv.slice(2));
