/** Read-only public-corpus validation; invoke with a non-git copy of the tracker root. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { listAllComplete } from "@unbrained/pm-cli/sdk";
import { compareGraphSnapshots, graphFromItems } from "../src/index.ts";
import type { Graph } from "../src/index.ts";
import { fingerprint as digest } from "../scripts/tracker-fingerprint.ts";

const tracker = resolve(process.argv[2]);
assert.equal(existsSync(join(dirname(dirname(tracker)), ".git")), false, "use a non-git copy");
const initial = digest(tracker);
const source = await listAllComplete({}, { pmRoot: tracker, noExtensions: true });
const before = graphFromItems(source.items, "public-tracker", new Map());
// Backends may supply evidence records explicitly. Map real linked docs into
// support facts here; this does not claim the linked content was verified.
const ids = new Set(before.nodes.map((node) => node.id));
for (const item of source.items) {
  for (const doc of item.docs ?? []) {
    const id = `doc:${createHash("sha256").update(`${doc.scope}:${doc.path}`).digest("hex").slice(0, 24)}`;
    if (!ids.has(id)) { ids.add(id); before.nodes.push({ id, labels: ["Evidence"], properties: { title: doc.path } }); }
    before.relationships.push({ from: id, to: item.id, type: "SUPPORTS", properties: {} });
  }
}
const reordered = structuredClone(before);
reordered.nodes.reverse(); reordered.relationships.reverse();
const started = performance.now();
let unchangedGoals = 0;
let refusedGoals = 0;
for (const item of source.items) {
  const result = compareGraphSnapshots(before, reordered, item.id);
  if (!result.ok) { refusedGoals++; continue; }
  assert.equal(result.changed, false);
  assert.deepEqual(result.changes, []);
  unchangedGoals++;
}
const candidates = before.relationships.filter((edge) => edge.type === "BLOCKED_BY");
const edge = candidates.find((candidate) => {
  const result = compareGraphSnapshots(before, before, candidate.from);
  return result.ok;
});
assert.ok(edge, "public corpus must supply a complete prerequisite goal");
const after: Graph = structuredClone(before);
after.nodes = after.nodes.filter((node) => node.id !== edge.to);
after.relationships = after.relationships.filter((rel) => rel.from !== edge.to && rel.to !== edge.to);
const removed = compareGraphSnapshots(before, after, edge.from);
assert.equal(removed.ok, true, JSON.stringify(removed));
if (!removed.ok) throw new Error("controlled removal refused");
assert.ok(removed.changes.some((row) => row.kind === "reachability-removed" && row.node.id === edge.to));
const evidenceEdge = before.relationships.find((rel) => rel.type === "SUPPORTS");
assert.ok(evidenceEdge);
const noSupport = structuredClone(before);
noSupport.relationships = noSupport.relationships.filter((rel) => !(rel.type === "SUPPORTS" && rel.from === evidenceEdge.from && rel.to === evidenceEdge.to));
const evidence = compareGraphSnapshots(before, noSupport, evidenceEdge.to);
assert.equal(evidence.ok, true, JSON.stringify(evidence));
if (!evidence.ok) throw new Error("controlled support removal refused");
assert.equal(evidence.changes.filter((row) => row.kind === "evidence-removed").length, 1);
const first = compareGraphSnapshots(before, after, edge.from, { limit: 1 });
assert.ok(first.ok);
const recovered = [];
let offset: number | null = 0;
while (offset !== null) {
  const page = compareGraphSnapshots(before, after, edge.from, { limit: 1, offset });
  assert.ok(page.ok);
  recovered.push(...page.changes);
  offset = page.receipt.output.nextOffset;
}
assert.deepEqual(recovered, removed.changes);
assert.equal(digest(tracker), initial, "source-copy file bytes and names must remain identical");
console.log(JSON.stringify({ items: source.complete_list.item_count, uniqueItems: source.complete_list.unique_item_id_count,
  sourceComplete: source.complete_list.source_complete, nodes: before.nodes.length, relationships: before.relationships.length,
  supportLinks: before.relationships.filter((rel) => rel.type === "SUPPORTS").length,
  reorderedGoalsCompared: unchangedGoals, reorderedGoalRefusals: refusedGoals, reorderedChanges: 0,
  removedNodes: 1, removalChanges: removed.changes.length, removalKinds: removed.changes.map((row) => row.kind),
  supportRemovalChanges: evidence.changes.length, pageLimit: 1, firstPageOmitted: first.receipt.output.omitted,
  recoveredRows: recovered.length, jsonBytes: Buffer.byteLength(JSON.stringify(removed)), elapsedMs: Math.round((performance.now() - started) * 100) / 100,
  sourceCopyUnchanged: true }, null, 2));
