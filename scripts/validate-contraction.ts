/** Validate a public tracker copy, emitting aggregate counts and byte sizes only. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { contractGraph, graphFromItems, contractionInputFromGraph } from "../src/index.ts";
import type { ContractionRow } from "../src/index.ts";
import { fingerprint } from "./validate-blocker-cuts.ts";
import { isMainInvocation } from "./main-invocation.ts";

/** Check the original source against every contracted answer without writing tracker records. */
export async function validateContraction(root: string): Promise<Record<string, unknown>> {
  const before = fingerprint(root);
  const started = performance.now();
  const snapshot = await new PmClient({ pmRoot: root, noExtensions: true }).listAllComplete();
  const graph = graphFromItems(snapshot.items, ".", new Map(), { includeFacets: false });
  assert.ok(graph.nodes.length > 0, "supply a nonempty public tracker");
  const boundary = [...new Set([...graph.relationships.flatMap((edge) => [edge.from, edge.to]), ...graph.nodes.map((node) => node.id)])].slice(0, 8);
  const edgeTypes = [...new Set(graph.relationships.map((edge) => edge.type))];
  if (!edgeTypes.length) edgeTypes.push("BLOCKED_BY");
  const input = { ...contractionInputFromGraph(graph, boundary, edgeTypes), limit: 1000 };
  let result = contractGraph(input);
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) throw new Error("contraction refused");
  const receipt = result.receipt;
  const rows: ContractionRow[] = [...result.rows];
  while (result.receipt.nextOffset !== null) {
    const page = contractGraph({ ...input, offset: result.receipt.nextOffset });
    assert.ok(page.ok);
    if (!page.ok) throw new Error("page refused");
    rows.push(...page.rows); result = page;
  }
  const groups = rows.filter((row) => row.kind === "group");
  assert.equal(new Set(groups.flatMap((group) => group.members)).size, graph.nodes.length);
  for (const from of boundary) {
    // Deliberately simple independent reference model used only by this validation script.
    const seen = new Set([from]); const queue = [from];
    for (let i = 0; i < queue.length; i++) for (const edge of input.edges)
      if (edge.from === queue[i] && !seen.has(edge.to)) { seen.add(edge.to); queue.push(edge.to); }
    for (const to of boundary) {
      const answer = rows.find((row) => row.kind === "answer" && row.from === from && row.to === to);
      assert.ok(answer && answer.kind === "answer");
      assert.equal(answer.reachable, seen.has(to));
    }
  }
  assert.equal(fingerprint(root), before, "input item/settings/history bytes must remain unchanged");
  return { sourceItems: snapshot.items.length, sourceComplete: snapshot.complete_list.source_complete,
    nodes: receipt.nodes, edges: receipt.edges, groups: receipt.groups, summaryEdges: receipt.summaryEdges,
    boundaryPairsChecked: receipt.boundaryPairs, cycles: receipt.cycles, unknown: receipt.unknown,
    nodeReduction: receipt.reduction, originalJsonBytes: Buffer.byteLength(JSON.stringify(graph)),
    contractedJsonBytes: Buffer.byteLength(JSON.stringify({ ...result, rows, receipt: { ...receipt, returned: rows.length, omitted: 0, nextOffset: null } })),
    elapsedMs: Math.round((performance.now() - started) * 100) / 100, inputUnchanged: true };
}

/** Print only aggregate evidence, never local source paths or item content. */
export async function main(args: readonly string[]): Promise<void> {
  if (args.length !== 1) throw new Error("Supply one non-git read-only public tracker copy.");
  console.log(JSON.stringify(await validateContraction(args[0]), null, 2));
}

if (isMainInvocation(process.argv, import.meta.url)) await main(process.argv.slice(2));
