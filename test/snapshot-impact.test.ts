import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { compareGraphSnapshots } from "../src/index.ts";
import type { Graph } from "../src/index.ts";
import type { SnapshotImpactOptions, SnapshotImpactRefusalCode } from "../src/snapshot-impact.ts";

/** Build small explicit SDK graphs; no workspace, SDK mocks or backing service. */
function graph(ids: string[] = ["goal", "a", "b"], edges: string[][] = [["goal", "a"], ["a", "b"]]): Graph {
  return { generatedAt: "fixture", workspace: ".", projectKey: "fixture", nodes: ids.map((id) => ({ id, labels: ["PmItem"], properties: { title: `Title ${id}`, status: "open" } })),
    relationships: edges.map(([from, to, type = "BLOCKED_BY"]) => ({ from, to, type, properties: {} })) };
}

/** Assert a complete semantic comparison while retaining refusal details on failure. */
function compare(before: Graph, after: Graph, options: SnapshotImpactOptions = {}) {
  const result = compareGraphSnapshots(before, after, "goal", options);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("comparison refused");
  return result;
}

/** Assert the typed refusal and actionable remedy instead of parsing exception messages. */
function refused(before: Graph, after: Graph, code: SnapshotImpactRefusalCode, options: SnapshotImpactOptions = {}) {
  const result = compareGraphSnapshots(before, after, "goal", options);
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) throw new Error("expected refusal");
  assert.equal(result.refusal.code, code);
  assert.ok(result.refusal.remedy.length > 20);
  assert.deepEqual(result.changes, []);
  return result;
}

test("reordering unchanged SDK snapshots, duplicate edges and backend metadata produce no changes", () => {
  const before = graph();
  before.nodes.push({ id: "proof", labels: ["Evidence"], properties: { title: "Evidence" } });
  before.relationships.push({ from: "proof", to: "a", type: "SUPPORTS", properties: { score: 1 } });
  const after = structuredClone(before);
  after.nodes.reverse();
  after.relationships.reverse();
  after.relationships.push(...after.relationships.map((edge) => ({ ...edge, properties: { changed: true } })));
  after.generatedAt = "later";
  after.workspace = "another-backend";
  after.projectKey = "other";
  after.nodes[0].properties.title = "A renamed proof";
  after.relationships.push({ from: "a", to: "b", type: "RELATED", properties: {} });
  const result = compare(before, after);
  assert.equal(result.changed, false);
  assert.deepEqual(result.changes, []);
  assert.equal(result.receipt.output.complete, true);
  assert.equal(result.receipt.cuts.before?.complete, true);
  assert.equal(result.receipt.cuts.after?.complete, true);
});

test("lost nodes retain old explanations and both traversal directions stay explicit", () => {
  const before = graph(["goal", "a", "b", "dependent", "proof"], [["goal", "a"], ["a", "b"], ["dependent", "goal"], ["proof", "b", "EVIDENCE_FOR"]]);
  before.nodes[2].properties = { title: "Removed prerequisite", status: "blocked" };
  const after = graph(["goal", "c", "next"], [["c", "goal", "BLOCKS"], ["next", "goal", "REQUIRES"]]);
  const result = compare(before, after);
  const upstream = result.changes.filter((row) => row.kind === "reachability-removed" && row.direction === "upstream");
  assert.equal(upstream.length, 2);
  assert.ok(upstream.some((row) => "node" in row && row.node.id === "b" && row.node.title === "Removed prerequisite" && row.node.status === "blocked"));
  assert.ok(result.changes.some((row) => row.kind === "reachability-added" && row.direction === "downstream" && row.node.id === "next"));
  assert.ok(result.changes.some((row) => row.kind === "reachability-removed" && row.direction === "downstream" && row.node.id === "dependent"));
  assert.deepEqual(result.changes.flatMap((row) => row.kind === "blocker-cut-removed" ? [row.blockers.map((node) => node.id)] : []), [["a"], ["b"]]);
  assert.deepEqual(result.changes.flatMap((row) => row.kind === "blocker-cut-added" ? [row.blockers.map((node) => node.id)] : []), [["c"]]);
  const support = result.changes.find((row) => row.kind === "evidence-removed");
  assert.ok(support && support.kind === "evidence-removed");
  assert.equal(support.target.title, "Removed prerequisite");
  assert.equal(support.evidence.id, "proof");
  // Stable changed output as well as stable no-change output.
  const shuffled = structuredClone(before);
  shuffled.nodes.reverse(); shuffled.relationships.reverse();
  assert.deepEqual(compare(shuffled, after), result);
});

test("AND cut alternatives and support loss through disconnected prerequisites are semantic", () => {
  const before = graph(["goal", "a", "b", "proof", "irrelevant"], [["goal", "a"], ["a", "b"], ["proof", "b", "SUPPORTS"], ["proof", "irrelevant", "SUPPORTS"]]);
  const after = structuredClone(before);
  after.relationships = after.relationships.filter((edge) => edge.from !== "a");
  const result = compare(before, after);
  assert.equal(result.changes.filter((row) => row.kind === "evidence-removed").length, 1);
  const reverse = compare(after, before);
  assert.equal(reverse.changes.filter((row) => row.kind === "evidence-added").length, 1);
  const fork = graph(["goal", "a", "b"], [["goal", "a"], ["goal", "b"]]);
  assert.deepEqual(compare(before, fork).changes.flatMap((row) => row.kind === "blocker-cut-added" ? [row.blockers.map((node) => node.id)] : []), [["a", "b"]]);
});

test("removed and added goals retain side context; absent goals refuse", () => {
  const empty = graph([], []);
  const before = graph();
  const removed = compare(before, empty);
  assert.equal(removed.goalBefore?.title, "Title goal");
  assert.equal(removed.goalAfter, null);
  assert.equal(removed.receipt.cuts.after, null);
  assert.equal(compare(empty, before).goalBefore, null);
  assert.equal(compare(empty, before).goalAfter?.id, "goal");
  refused(empty, empty, "UNKNOWN_GOAL");
});

test("bounded output exposes exact omissions, recoverable pages and Unicode clipping", () => {
  const before = graph(["goal", "a"], [["goal", "a"]]);
  before.nodes[1].properties.title = "😀".repeat(170);
  before.nodes[1].properties.status = "custom".repeat(20);
  const options = { cutOptions: { unresolvedStatuses: ["open", "custom".repeat(20)] } };
  const after = graph(["goal"], []);
  const full = compare(before, after, options);
  const first = compare(before, after, { ...options, limit: 1 });
  assert.equal(first.receipt.output.returned, 1);
  assert.equal(first.receipt.output.omitted, full.changes.length - 1);
  assert.equal(first.receipt.output.complete, false);
  const recovered = [...first.changes];
  let next = first.receipt.output.nextOffset;
  while (next !== null) {
    const page = compare(before, after, { ...options, limit: 1, offset: next });
    recovered.push(...page.changes);
    next = page.receipt.output.nextOffset;
  }
  assert.deepEqual(recovered, full.changes);
  const row = recovered[0];
  assert.ok("node" in row);
  assert.equal(Array.from(row.node.title).length, 160);
  assert.equal(row.node.textClipped, true);
  assert.equal(row.node.status.length, 64);
  const beyond = compare(before, after, { ...options, offset: 999 });
  assert.deepEqual(beyond.changes, []);
  assert.equal(beyond.receipt.output.nextOffset, null);
  assert.equal(beyond.receipt.output.omitted, full.changes.length);
});

test("missing title/status fallback context never invents a cut status", () => {
  const before = graph(["goal", "proof"], [["proof", "goal", "SUPPORTS"]]);
  before.nodes[1].labels = ["Evidence"];
  before.nodes[1].properties = {};
  const after = graph(["goal"], []);
  const row = compare(before, after).changes[0];
  assert.ok(row.kind === "evidence-removed");
  assert.deepEqual(row.evidence, { id: "proof", title: "proof", status: "unknown", textClipped: false });
});

test("options refuse invalid numeric bounds and incomplete cut searches with remedies", () => {
  for (const limit of [0, -1, 1.5, NaN, 257]) refused(graph(), graph(), "INVALID_OPTIONS", { limit });
  for (const offset of [-1, 1.5, Infinity]) refused(graph(), graph(), "INVALID_OPTIONS", { offset });
  for (const maxWork of [0, 1.5, 20_000_001]) refused(graph(), graph(), "INVALID_OPTIONS", { maxWork });
  refused(graph(), graph(), "WORK_LIMIT", { maxWork: 1 });
  refused(graph(), graph(), "CUT_SEARCH_INCOMPLETE", { cutOptions: { maxCuts: 1 } });
  for (const key of ["maxStates", "maxWork", "maxSize"] as const) {
    const result = refused(graph(), graph(), "CUT_SEARCH_INCOMPLETE", { cutOptions: { [key]: 1 } });
    assert.ok(result.remediation.includes("--cut-max-"));
  }
  const invalidCut = refused(graph(), graph(), "CUT_REFUSED", { cutOptions: { maxCuts: 0 } });
  assert.equal(invalidCut.refusal.cutCode, "INVALID_OPTIONS");
  // Spend the entire traversal budget, then hit the evidence accounting cap.
  const evidence = graph(["goal", "proof"], [["proof", "goal", "SUPPORTS"]]);
  refused(evidence, evidence, "WORK_LIMIT", { maxWork: 4 });
  for (let maxWork = 1; maxWork <= 20; maxWork++) compareGraphSnapshots(graph(), graph(), "goal", { maxWork });
});

test("custom registry statuses, cycles and missing endpoints are never guessed", () => {
  const cycle = graph(["goal", "a"], [["goal", "a"], ["a", "goal"]]);
  assert.equal(refused(cycle, cycle, "CUT_REFUSED").refusal.cutCode, "CYCLE");
  const custom = graph();
  custom.nodes[1].properties.status = "done";
  assert.equal(refused(custom, custom, "CUT_REFUSED").refusal.cutCode, "INCOMPLETE_GRAPH");
  assert.equal(compare(custom, custom, { cutOptions: { resolvedStatuses: ["done"], unresolvedStatuses: ["open"] } }).changed, false);
  for (const side of ["before", "after"] as const) {
    const incomplete = graph(["goal"], [["goal", "missing"]]);
    const result = side === "before" ? refused(incomplete, graph(), "INCOMPLETE_GRAPH") : refused(graph(), incomplete, "INCOMPLETE_GRAPH");
    assert.equal(result.refusal.side, side);
  }
  const proof = graph(["goal"], [["missing", "goal", "SUPPORTS"]]);
  refused(proof, proof, "INCOMPLETE_GRAPH");
  const dangling = graph(["goal", "a"], [["goal", "a"]]);
  const afterDeletion = structuredClone(dangling);
  afterDeletion.nodes.pop();
  const deletion = refused(dangling, afterDeletion, "INCOMPLETE_GRAPH");
  assert.equal(deletion.missingNode?.before?.title, "Title a");
  assert.equal(deletion.missingNode?.after, null);
  assert.equal(deletion.refusal.side, "after");
  // Missing evidence to an unrelated node is outside the explicit comparison scope.
  assert.equal(compare(graph(["goal"], [["missing", "unrelated", "SUPPORTS"]]), graph(["goal"], [])).changed, false);
});

test("untrusted JSON graphs reject malformed shape, duplicate ids and size overflow", () => {
  const malformed: unknown[] = [null, {}, { nodes: [] }, { nodes: null, relationships: [] },
    { ...graph(), nodes: [null] }, { ...graph(), nodes: [{ id: "", labels: [], properties: {} }] },
    { ...graph(), nodes: [{ id: "x".repeat(257), labels: [], properties: {} }] },
    { ...graph(), nodes: [{ id: "goal", labels: [1], properties: {} }] },
    { ...graph(), nodes: [{ id: "goal", labels: [], properties: [] }] },
    { ...graph(), relationships: [null] }, { ...graph(), relationships: [{ from: "goal", to: "a", type: 1, properties: {} }] },
    { ...graph(), relationships: [{ from: "goal", to: "a", type: "BLOCKED_BY", properties: null }] }, graph(["goal", "goal"], [])];
  for (const value of malformed) refused(value as Graph, graph(), "INVALID_SNAPSHOT");
  refused(graph(), null as unknown as Graph, "INVALID_SNAPSHOT");
  refused({ ...graph(), nodes: Array.from({ length: 10_001 }, () => graph().nodes[0]) }, graph(), "GRAPH_LIMIT");
  refused({ ...graph(), relationships: Array.from({ length: 50_001 }, () => graph().relationships[0]) }, graph(), "GRAPH_LIMIT");
  // External placeholders cannot certify a local graph neighborhood.
  const external = graph();
  external.nodes[1].labels = ["ExternalPmItem"];
  refused(external, external, "INCOMPLETE_GRAPH");
});

test("documented cut-size completion bounds match executed snapshot comparisons", () => {
  for (const path of ["../README.md", "../docs/snapshot-impact-example.md"]) {
    const documentation = readFileSync(new URL(path, import.meta.url), "utf8").replace(/\s+/g, " ");
    const bounds = /Completion requires `--cut-max-size` \(default (\d+), hard cap (\d+)\) to be at least the number of unresolved prerequisites in the active cone, excluding the goal\./.exec(documentation);
    assert.ok(bounds, `${path} must distinguish exhaustive completion from the preflight cone cap`);
    const defaultSize = Number(bounds[1]);
    const hardCap = Number(bounds[2]);
    assert.equal(compare(graph(), graph()).receipt.cuts.before?.limits.maxSize, defaultSize);
    const ids = ["goal", ...Array.from({ length: defaultSize + 1 }, (_, index) => `prerequisite-${index}`)];
    const chain = graph(ids, ids.slice(1).map((id, index) => [ids[index], id]));
    for (const side of ["before", "after"] as const) {
      const result = side === "before"
        ? refused(chain, graph(), "CUT_SEARCH_INCOMPLETE")
        : refused(graph(), chain, "CUT_SEARCH_INCOMPLETE");
      assert.equal(result.refusal.side, side);
      assert.match(result.refusal.remedy, /--cut-max-size/);
    }
    const complete = compare(chain, chain, { cutOptions: { maxSize: defaultSize + 1 } });
    assert.equal(complete.changed, false);
    assert.equal(complete.receipt.cuts.before?.complete, true);
    assert.equal(complete.receipt.cuts.after?.complete, true);
    assert.equal(complete.receipt.cuts.before?.limits.maxSize, defaultSize + 1);
    compare(graph(), graph(), { cutOptions: { maxSize: hardCap } });
    const overCap = refused(graph(), graph(), "CUT_REFUSED", { cutOptions: { maxSize: hardCap + 1 } });
    assert.equal(overCap.refusal.cutCode, "INVALID_OPTIONS");
  }
});
