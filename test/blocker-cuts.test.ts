import assert from "node:assert/strict";
import test from "node:test";
import { minimalBlockerCuts } from "../src/blocker-cuts.ts";
import type { BlockerCutOptions, BlockerCutResult } from "../src/blocker-cuts.ts";
import type { Graph } from "../src/index.ts";
import { synthNode, synthRel } from "./helpers.ts";

/** Build an input snapshot with no dependency on a repository or filesystem. */
function graph(ids: string[], pairs: string[][] = []): Graph {
  return { generatedAt: "fixture", workspace: ".", projectKey: "fixture",
    nodes: ids.map((id) => synthNode(id)), relationships: pairs.map(([from, to]) => synthRel(from, to, "BLOCKED_BY")) };
}

/** Narrow a successful result so test failures retain the full refusal receipt. */
function success(input: Graph, goal = "g", options: BlockerCutOptions = {}) {
  const result = minimalBlockerCuts(input, goal, options);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("expected success");
  return result;
}

/** Independent oracle: enumerate complete root-to-leaf paths, then all hitting sets. */
function oracle(ids: string[], pairs: string[][], goal: string): string[][] {
  const paths: string[][] = [];
  const walk = (id: string, chain: string[]): void => {
    const next = pairs.filter(([from]) => from === id).map(([, to]) => to);
    if (!next.length) paths.push(chain);
    for (const to of next) walk(to, [...chain, to]);
  };
  walk(goal, []);
  if (paths.some((chain) => chain.length === 0)) return [[]];
  const candidates = ids.filter((id) => id !== goal);
  const hits: string[][] = [];
  for (let mask = 0; mask < 2 ** candidates.length; mask++) {
    const set = candidates.filter((_, index) => (mask & (1 << index)) !== 0);
    if (paths.every((chain) => chain.some((id) => set.includes(id)))) hits.push(set);
  }
  return hits.filter((set) => !hits.some((other) => other.length < set.length && other.every((id) => set.includes(id))))
    .sort((a, b) => a.length - b.length || a.join(",").localeCompare(b.join(",")));
}

test("all 1024 five-node DAGs agree with brute-force minimal path hitting sets", () => {
  const ids = ["a", "b", "c", "d", "g"];
  const possible = ids.flatMap((from, i) => ids.slice(0, i).map((to) => [from, to]));
  for (let mask = 0; mask < 2 ** possible.length; mask++) {
    const pairs = possible.filter((_, bit) => (mask & (1 << bit)) !== 0);
    const input = graph(ids, pairs);
    // Reverse half the edges into BLOCKS; duplicate edges must not change the proof.
    input.relationships = input.relationships.flatMap((rel, i) => i % 2
      ? [synthRel(rel.to, rel.from, "BLOCKS")]
      : [rel, { ...rel }]);
    const result = success(input);
    assert.deepEqual(result.cuts.map((cut) => cut.blockers), oracle(ids, pairs, "g"), `graph ${mask}`);
    assert.equal(result.receipt.search.complete, true);
    assert.equal(result.receipt.search.minimumCardinality, result.cuts[0].blockers.length);
  }
});

test("chain alternatives distinguish plan frontiers from immediate eligibility", () => {
  const result = success(graph(["g", "a", "b"], [["g", "a"], ["a", "b"]]));
  assert.deepEqual(result.cuts, [
    { blockers: ["a"], immediatelyUnblocked: true },
    { blockers: ["b"], immediatelyUnblocked: false },
  ]);
  assert.equal(result.semantics, "upstream-frontier");
  assert.equal(result.receipt.search.completeThroughSize, 2);
  const reordered = graph(["b", "a", "g"], [["a", "b"], ["g", "a"]]);
  assert.deepEqual(success(reordered), result);
});

test("AND forks, unequal-sized alternatives and non-gating metadata stay distinct", () => {
  const input = graph(["g", "a", "b", "c", "unrelated"], [["g", "a"], ["a", "b"], ["a", "c"]]);
  for (const type of ["CHILD_OF", "RELATED", "RELATES_TO", "TAGGED_WITH", "HAS_STATUS"]) input.relationships.push(synthRel("g", "unrelated", type));
  input.relationships[0].type = "DEPENDS_ON";
  input.relationships[1].type = "REQUIRES";
  assert.deepEqual(success(input).cuts.map((cut) => cut.blockers), [["a"], ["b", "c"]]);
  const diamond = graph(["g", "a", "b", "c"], [["g", "a"], ["g", "b"], ["a", "c"], ["b", "c"]]);
  assert.deepEqual(success(diamond).cuts.map((cut) => cut.blockers), [["c"], ["a", "b"]]);
});

test("terminal boundaries and registry status sets preserve unresolved meaning", () => {
  const input = graph(["g", "a", "b"], [["g", "a"], ["a", "missing"], ["b", "b"]]);
  for (const status of ["closed", "canceled"]) {
    input.nodes[1].properties.status = status;
    assert.deepEqual(success(input).cuts, [{ blockers: [], immediatelyUnblocked: true }]);
  }
  input.nodes[0].properties.status = "closed";
  assert.equal(success(input).goalResolved, true);
  input.nodes[0].properties.status = "ready";
  input.nodes[1].properties.status = "done";
  assert.equal(success(input, "g", { resolvedStatuses: ["done"], unresolvedStatuses: ["ready"] }).goalResolved, false);
});

test("cycles and unknown items/statuses are explicit refusals confined to the active cone", () => {
  const cycle = graph(["g", "a", "b"], [["g", "a"], ["a", "b"], ["b", "a"]]);
  const result = minimalBlockerCuts(cycle, "g");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, "CYCLE");
  assert.deepEqual(result.receipt.graph.cycle, ["a", "b", "a"]);
  assert.equal(result.receipt.graph.complete, true);
  assert.deepEqual(minimalBlockerCuts(graph(["g"], [["g", "g"]]), "g").receipt.graph.cycle, ["g", "g"]);
  const unknown = graph(["g", "bad"], [["g", "missing"], ["g", "external"], ["g", "bad"]]);
  unknown.nodes.push({ id: "external", labels: ["ExternalPmItem"], properties: {} });
  unknown.nodes[1].properties.status = "unregistered";
  const refused = minimalBlockerCuts(unknown, "g");
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.refusal.code, "INCOMPLETE_GRAPH");
  assert.deepEqual(refused.receipt.graph.unknownNodes, ["external", "missing"]);
  assert.deepEqual(refused.receipt.graph.unknownStatuses, ["bad"]);
  assert.equal(refused.receipt.search.reason, "refused");
  assert.equal(minimalBlockerCuts(unknown, "absent").ok, false);
  assert.equal(success(graph(["g", "a"], [["a", "a"], ["a", "absent"]])).receipt.graph.complete, true);
});

test("every search cap preserves minimal cuts, exact accounting and honest completeness", () => {
  const input = graph(["g", "a", "b", "c"], [["g", "a"], ["a", "b"], ["a", "c"]]);
  const expected = oracle(["g", "a", "b", "c"], [["g", "a"], ["a", "b"], ["a", "c"]], "g");
  for (const [key, reason] of [["maxStates", "maxStates"], ["maxWork", "maxWork"], ["maxCuts", "maxCuts"], ["maxSize", "maxSize"]] as const) {
    const result = success(input, "g", { [key]: 1 });
    assert.equal(result.receipt.search.complete, false);
    assert.equal(result.receipt.search.reason, reason);
    for (const cut of result.cuts) assert.ok(expected.some((set) => JSON.stringify(set) === JSON.stringify(cut.blockers)));
  }
  // Exercise exhaustion during traversal, subset comparison and edge accounting.
  for (let maxWork = 1; maxWork <= 100; maxWork++) {
    const result = success(input, "g", { maxWork });
    assert.ok(result.receipt.search.work <= maxWork);
  }
  const fork = graph(["g", "a", "b"], [["g", "a"], ["g", "b"]]);
  const partial = success(fork, "g", { maxSize: 1 });
  assert.deepEqual(partial.cuts, []);
  assert.equal(partial.receipt.search.minimumCardinality, null);
  assert.equal(partial.receipt.search.completeThroughSize, 1);
  const large = graph(["g", ...Array.from({ length: 100 }, (_, i) => `n${i}`)], Array.from({ length: 100 }, (_, i) => ["g", `n${i}`]));
  const bounded = success(large, "g", { maxStates: 20 });
  assert.equal(bounded.receipt.search.states, 20);
  assert.equal(bounded.receipt.search.reason, "maxStates");
});

test("invalid budgets, duplicate identity, and hard graph caps refuse with remedies", () => {
  const input = graph(["g"]);
  const checks: Array<[BlockerCutResult, string]> = [];
  for (const key of ["maxStates", "maxWork", "maxCuts", "maxSize"] as const) {
    for (const value of [0, -1, 1.5, NaN, Infinity, 20_000_001]) checks.push([minimalBlockerCuts(input, "g", { [key]: value }), "INVALID_OPTIONS"]);
  }
  checks.push([minimalBlockerCuts(input, "g", { resolvedStatuses: ["open"] }), "INVALID_OPTIONS"]);
  checks.push([minimalBlockerCuts(graph(["g", "g"]), "g"), "INVALID_GRAPH"]);
  checks.push([minimalBlockerCuts(input, "missing"), "UNKNOWN_GOAL"]);
  checks.push([minimalBlockerCuts({ ...input, nodes: Array.from({ length: 100_001 }, () => input.nodes[0]) }, "g"), "GRAPH_LIMIT"]);
  checks.push([minimalBlockerCuts({ ...input, relationships: Array.from({ length: 500_001 }, () => synthRel("g", "g", "BLOCKED_BY")) }, "g"), "GRAPH_LIMIT"]);
  const ids = Array.from({ length: 513 }, (_, i) => `n${i}`);
  checks.push([minimalBlockerCuts(graph(ids, ids.slice(1).map((id, i) => [ids[i], id])), "n0"), "GRAPH_LIMIT"]);
  for (const [result, code] of checks) {
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.refusal.code, code); assert.ok(result.refusal.remedy.length > 20); }
  }
});

test("missing-data refusal samples are bounded and retain total counts", () => {
  const ids = Array.from({ length: 100 }, (_, i) => `missing${i}`);
  const result = minimalBlockerCuts(graph(["g"], ids.map((id) => ["g", id])), "g");
  assert.equal(result.ok, false);
  assert.equal(result.receipt.graph.unknownNodeCount, 100);
  assert.equal(result.receipt.graph.unknownNodes.length, 32);
  const statuses = graph(["g", ...ids], ids.map((id) => ["g", id]));
  for (const node of statuses.nodes.slice(1)) node.properties.status = "custom";
  const unknown = minimalBlockerCuts(statuses, "g");
  assert.equal(unknown.receipt.graph.unknownStatusCount, 100);
  assert.equal(unknown.receipt.graph.unknownStatuses.length, 32);
});
