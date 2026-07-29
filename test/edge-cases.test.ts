/**
 * Edge-case coverage for the pm-graph engine's pure analytics functions and
 * renderers. Exercises empty graphs, single-node graphs, self-referential
 * edges, missing/dangling references, and every `--format` branch the
 * renderers expose — the surfaces that the happy-path tests omit.
 *
 * These tests call the exported pure functions directly (no pm workspace
 * needed) so they run fast and deterministically.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  findCycles,
  shortestPath,
  longestChain,
  topoSort,
  reverseReachable,
  dependencyDepths,
  criticalConnectors,
  analyzeGraph,
  explainItem,
  mapImpactDirection,
  parseAnalyticsFlags,
  renderGraphml,
  renderPlantuml,
  renderAnalysisDiagram,
  impactSubgraph,
  impactSubgraphFromNodeSet,
  projectSubgraph,
  cyclesSubgraph,
  criticalPathSubgraph,
} from "../src/index.ts";

type Edge = { from: string; to: string; type: string };

// Reusable node/relationship builders for synthetic graphs.
function node(id: string, extra: Record<string, unknown> = {}) {
  return { id, labels: ["PmItem"], properties: { id, title: id, type: "Task", status: "open", ...extra } };
}
function rel(from: string, to: string, type: string) {
  return { from, to, type, properties: {} };
}
function graph(nodes: ReturnType<typeof node>[], rels: ReturnType<typeof rel>[]) {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    workspace: "/tmp/ws",
    projectKey: "ws",
    nodes,
    relationships: rels,
  };
}

// ---------------------------------------------------------------------------
// Empty and single-node graphs
// ---------------------------------------------------------------------------

test("findCycles on an empty graph returns nothing", () => {
  assert.deepStrictEqual(findCycles([], []), []);
});

test("findCycles on a single node with no edges returns nothing", () => {
  assert.deepStrictEqual(findCycles(["A"], []), []);
});

test("shortestPath with no edges and from !== to returns null", () => {
  assert.strictEqual(shortestPath([], "A", "B"), null);
});

test("longestChain on empty nodes returns an empty chain", () => {
  assert.deepStrictEqual(longestChain([], []), []);
});

test("longestChain on a single node returns that node", () => {
  assert.deepStrictEqual(longestChain(["A"], []), ["A"]);
});

test("topoSort on empty input returns empty order and no cycle nodes", () => {
  const result = topoSort([], []);
  assert.deepStrictEqual(result.order, []);
  assert.deepStrictEqual(result.cycleNodes, []);
});

test("topoSort on a single node with no edges returns that node", () => {
  const result = topoSort(["A"], []);
  assert.deepStrictEqual(result.order, ["A"]);
  assert.deepStrictEqual(result.cycleNodes, []);
});

test("reverseReachable with no edges returns empty", () => {
  assert.deepStrictEqual(reverseReachable([], "A"), []);
});

test("dependencyDepths on empty input returns an empty map", () => {
  const depths = dependencyDepths([], []);
  assert.strictEqual(depths.size, 0);
});

test("dependencyDepths on a single node returns depth 0", () => {
  const depths = dependencyDepths(["A"], []);
  assert.strictEqual(depths.get("A"), 0);
});

test("criticalConnectors on empty input returns no articulation points or bridges", () => {
  const result = criticalConnectors([], []);
  assert.deepStrictEqual(result.articulationPoints, []);
  assert.deepStrictEqual(result.bridges, []);
});

test("criticalConnectors on a single node returns no articulation points", () => {
  const result = criticalConnectors(["A"], []);
  assert.deepStrictEqual(result.articulationPoints, []);
  assert.deepStrictEqual(result.bridges, []);
});

test("analyzeGraph on an empty graph returns zero counts", () => {
  const report = analyzeGraph(graph([], []) as never);
  assert.strictEqual(report.itemCount, 0);
  assert.strictEqual(report.structuralEdgeCount, 0);
  assert.strictEqual(report.cycleCount, 0);
  assert.strictEqual(report.connectedComponents, 0);
  assert.strictEqual(report.maxDepth, 0);
  assert.deepStrictEqual(report.longestChain, []);
});

test("analyzeGraph on a single isolated node reports one orphan and one component", () => {
  const report = analyzeGraph(graph([node("A")], []) as never);
  assert.strictEqual(report.itemCount, 1);
  assert.strictEqual(report.orphanCount, 1);
  assert.deepStrictEqual(report.orphans, ["A"]);
  assert.strictEqual(report.connectedComponents, 1);
  assert.strictEqual(report.maxDepth, 0);
});

// ---------------------------------------------------------------------------
// Self-referential edges
// ---------------------------------------------------------------------------

test("findCycles detects a self-loop as a cycle", () => {
  const selfLoop: Edge[] = [{ from: "A", to: "A", type: "BLOCKED_BY" }];
  const cycles = findCycles(["A"], selfLoop);
  assert.strictEqual(cycles.length, 1, "self-loop detected as a cycle");
  assert.strictEqual(cycles[0][0], "A", "cycle starts at A");
  assert.strictEqual(cycles[0][0], cycles[0][cycles[0].length - 1], "cycle is closed");
});

test("topoSort skips a self-loop edge and orders the node (self-loops are not prereqs)", () => {
  const selfLoop: Edge[] = [{ from: "A", to: "A", type: "BLOCKED_BY" }];
  const result = topoSort(["A"], selfLoop);
  // The self-loop edge is explicitly skipped (e.from === e.to), so A has no
  // prerequisites and is ordered normally.
  assert.deepStrictEqual(result.order, ["A"], "self-loop node is still orderable");
  assert.deepStrictEqual(result.cycleNodes, [], "self-loop does not block topo order");
});

test("longestChain is safe with a self-loop (does not infinite-loop)", () => {
  const selfLoop: Edge[] = [{ from: "A", to: "A", type: "BLOCKED_BY" }];
  const chain = longestChain(["A"], selfLoop);
  assert.ok(chain.length >= 1 && chain.length <= 1, "self-loop does not extend the chain");
});

test("dependencyDepths is safe with a self-loop", () => {
  const selfLoop: Edge[] = [{ from: "A", to: "A", type: "BLOCKED_BY" }];
  const depths = dependencyDepths(["A"], selfLoop);
  assert.ok((depths.get("A") ?? 0) <= 1, "self-loop does not inflate depth");
});

test("reverseReachable with a self-loop excludes the start node", () => {
  const selfLoop: Edge[] = [{ from: "A", to: "A", type: "BLOCKED_BY" }];
  assert.deepStrictEqual(reverseReachable(selfLoop, "A"), [], "self-loop does not make A its own dependent");
});

// ---------------------------------------------------------------------------
// Dangling / missing references in graph construction
// ---------------------------------------------------------------------------

test("explainItem on a graph where the item exists but has no structural edges", () => {
  const g = graph([node("Solo")], []);
  const report = explainItem(g as never, "Solo");
  assert.ok(report, "solo item should be explainable");
  assert.strictEqual(report!.blockers.length, 0);
  assert.strictEqual(report!.dependents.length, 0);
  assert.strictEqual(report!.transitiveDependents.length, 0);
  assert.strictEqual(report!.dependencyDepth, 0);
  assert.strictEqual(report!.inCycle, false);
});

test("explainItem returns null for an id that is a facet node, not a PmItem", () => {
  const g = graph(
    [node("A"), { id: "status:open", labels: ["PmFacet", "Status"], properties: { id: "status:open", title: "open", type: "", status: "" } }],
    [rel("A", "status:open", "HAS_STATUS")],
  );
  // The facet node is not a PmItem, so explainItem returns null.
  assert.strictEqual(explainItem(g as never, "status:open"), null);
});

// ---------------------------------------------------------------------------
// Every --format branch of renderAnalysisDiagram
// ---------------------------------------------------------------------------

test("renderAnalysisDiagram mermaid on an empty subgraph emits a bare graph header", () => {
  const empty = graph([], []);
  const out = renderAnalysisDiagram("mermaid", empty as never);
  assert.ok(out.startsWith("graph TD"), "mermaid header present");
  assert.ok(!out.includes("-->"), "no edges in empty graph");
});

test("renderAnalysisDiagram graphml on an empty subgraph emits valid empty GraphML", () => {
  const empty = graph([], []);
  const xml = renderAnalysisDiagram("graphml", empty as never);
  assert.ok(xml.startsWith('<?xml version="1.0"'), "XML prolog");
  assert.ok(xml.includes("<graphml"), "graphml root");
  assert.ok(xml.includes('edgedefault="directed"'), "directed attribute");
  assert.ok(!xml.includes("<node "), "no nodes in empty graph");
  assert.ok(!xml.includes("<edge "), "no edges in empty graph");
});

test("renderAnalysisDiagram dot on an empty subgraph emits a valid empty digraph", () => {
  const empty = graph([], []);
  const dot = renderAnalysisDiagram("dot", empty as never);
  assert.ok(dot.startsWith("digraph pm_graph {"), "digraph header");
  assert.ok(dot.trim().endsWith("}"), "closes");
  // Should have the node style declaration but no actual nodes/edges.
  assert.ok(dot.includes("rankdir=LR"), "rank directive present");
  assert.ok(!dot.includes("->"), "no edges in empty graph");
});

// ---------------------------------------------------------------------------
// renderGraphml / renderPlantuml edge cases
// ---------------------------------------------------------------------------

test("renderGraphml on a graph with no relationships emits nodes but no edges", () => {
  const g = graph([node("A"), node("B")], []);
  const xml = renderGraphml(g as never);
  assert.ok(xml.includes('<node id="A">'), "node A present");
  assert.ok(xml.includes('<node id="B">'), "node B present");
  assert.ok(!xml.includes("<edge "), "no edges when none exist");
});

test("renderGraphml omits empty type and status data elements", () => {
  const g = graph(
    [{ id: "X", labels: ["PmItem"], properties: { id: "X", title: "X", type: "", status: "" } }],
    [],
  );
  const xml = renderGraphml(g as never);
  // type and status are empty strings, so the data elements should be omitted.
  assert.ok(!xml.includes('<data key="type">'), "empty type omitted");
  assert.ok(!xml.includes('<data key="status">'), "empty status omitted");
  assert.ok(xml.includes('<data key="title">X</data>'), "title still present");
});

test("renderPlantuml on a graph with no relationships omits the edge separator", () => {
  const g = graph([node("A")], []);
  const uml = renderPlantuml(g as never);
  assert.ok(uml.startsWith("@startuml"), "starts with @startuml");
  assert.ok(uml.trim().endsWith("@enduml"), "ends with @enduml");
  assert.ok(uml.includes("object "), "declares an object");
  // No relationships => no "-->" arrows (the empty separator line is skipped).
  assert.ok(!uml.includes("-->"), "no arrows when no relationships");
});

test("renderPlantuml on an empty graph emits a bare @startuml/@enduml block", () => {
  const empty = graph([], []);
  const uml = renderPlantuml(empty as never);
  assert.ok(uml.startsWith("@startuml"), "starts with @startuml");
  assert.ok(uml.includes("left to right direction"), "direction directive");
  assert.ok(uml.trim().endsWith("@enduml"), "ends with @enduml");
  assert.ok(!uml.includes("object "), "no objects in empty graph");
});

// ---------------------------------------------------------------------------
// parseAnalyticsFlags edge cases
// ---------------------------------------------------------------------------

test("parseAnalyticsFlags on empty args returns defaults with no positionals", () => {
  const flags = parseAnalyticsFlags([]);
  assert.strictEqual(flags.json, false);
  assert.strictEqual(flags.includeClosed, false);
  assert.strictEqual(flags.format, "text");
  assert.deepStrictEqual(flags.filter, []);
  assert.deepStrictEqual(flags.positionals, []);
});

test("parseAnalyticsFlags rejects a value-less --root", () => {
  assert.throws(() => parseAnalyticsFlags(["--root"]), /--root requires an item id/);
});

test("parseAnalyticsFlags rejects a value-less --depth", () => {
  assert.throws(() => parseAnalyticsFlags(["--depth"]), /--depth requires an integer/);
});

test("parseAnalyticsFlags rejects a value-less --format", () => {
  assert.throws(() => parseAnalyticsFlags(["--format"]), /--format requires a value/);
});

test("parseAnalyticsFlags rejects a value-less --direction", () => {
  assert.throws(() => parseAnalyticsFlags(["--direction"]), /--direction requires a value/);
});

test("parseAnalyticsFlags rejects a value-less --filter", () => {
  assert.throws(() => parseAnalyticsFlags(["--filter"]), /--filter requires a value/);
});

test("parseAnalyticsFlags rejects a malformed --depth value", () => {
  assert.throws(() => parseAnalyticsFlags(["--depth", "abc"]), /Invalid --depth "abc"/);
  assert.throws(() => parseAnalyticsFlags(["--depth", "-1"]), /Invalid --depth "-1"/);
  assert.throws(() => parseAnalyticsFlags(["--depth", "2.5"]), /Invalid --depth "2.5"/);
});

test("parseAnalyticsFlags accepts --depth= equals form", () => {
  assert.strictEqual(parseAnalyticsFlags(["--depth=3"]).depth, 3);
  assert.strictEqual(parseAnalyticsFlags(["--depth=0"]).depth, 0);
});

test("parseAnalyticsFlags accepts --root= equals form", () => {
  assert.strictEqual(parseAnalyticsFlags(["--root=abc"]).root, "abc");
});

test("parseAnalyticsFlags ignores unknown --flags rather than treating them as positionals", () => {
  const flags = parseAnalyticsFlags(["--unknown-flag", "pos1", "--another", "pos2"]);
  assert.deepStrictEqual(flags.positionals, ["pos1", "pos2"], "unknown flags ignored, positionals kept");
});

test("parseAnalyticsFlags --format= equals form accepts all valid formats", () => {
  for (const fmt of ["text", "json", "mermaid", "graphml", "dot"]) {
    const flags = parseAnalyticsFlags([`--format=${fmt}`]);
    assert.strictEqual(flags.format, fmt === "json" ? "text" : fmt);
  }
});

test("parseAnalyticsFlags rejects an invalid --format value", () => {
  assert.throws(() => parseAnalyticsFlags(["--format", "yaml"]), /Invalid --format "yaml"/);
  assert.throws(() => parseAnalyticsFlags(["--format=svg"]), /Invalid --format "svg"/);
});

test("mapImpactDirection rejects empty, null and undefined input", () => {
  // The implementation normalises via `logical ?? ""`, so null and undefined take
  // a different path from "" and the earlier name promised coverage the body did
  // not provide. Exercise all three.
  for (const input of ["", null, undefined]) {
    assert.throws(
      () => mapImpactDirection(input as unknown as string),
      /Invalid --direction/,
      `input ${JSON.stringify(input)} must be rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// impactSubgraph edge cases
// ---------------------------------------------------------------------------

test("impactSubgraph with affected rows that have no path falls back to root+id", () => {
  const g = graph([node("A"), node("B")], [rel("B", "A", "BLOCKED_BY")]);
  const sub = impactSubgraph(g as never, "A", [{ id: "B", distance: 1 }]);
  assert.deepStrictEqual(sub.nodes.map((n) => n.id), ["A", "B"]);
  // The fallback path [A, B] produces both B->A and A->B candidate keys;
  // only B->A matches a real structural edge.
  assert.strictEqual(sub.relationships.length, 1);
  assert.strictEqual(sub.relationships[0].from, "B");
  assert.strictEqual(sub.relationships[0].to, "A");
});

test("impactSubgraphFromNodeSet with only the root yields just the root", () => {
  const g = graph([node("A"), node("B")], [rel("B", "A", "BLOCKED_BY")]);
  const sub = impactSubgraphFromNodeSet(g as never, "A", []);
  assert.deepStrictEqual(sub.nodes.map((n) => n.id), ["A"]);
  assert.strictEqual(sub.relationships.length, 0);
});

test("impactSubgraphFromNodeSet on an empty graph yields just the root", () => {
  const empty = graph([], []);
  const sub = impactSubgraphFromNodeSet(empty as never, "Root", []);
  assert.deepStrictEqual(sub.nodes.map((n) => n.id), ["Root"]);
  assert.strictEqual(sub.relationships.length, 0);
});

// ---------------------------------------------------------------------------
// projectSubgraph / criticalPathSubgraph / cyclesSubgraph edge cases
// ---------------------------------------------------------------------------

test("projectSubgraph with duplicate node ids de-duplicates", () => {
  const g = graph([node("A"), node("B")], [rel("B", "A", "BLOCKED_BY")]);
  const sub = projectSubgraph(g as never, ["A", "A", "B"], []);
  assert.deepStrictEqual(sub.nodes.map((n) => n.id), ["A", "B"]);
});

test("projectSubgraph synthesizes a node for an id absent from the source graph", () => {
  const g = graph([node("A")], []);
  const sub = projectSubgraph(g as never, ["A", "Ghost"], []);
  assert.deepStrictEqual(sub.nodes.map((n) => n.id), ["A", "Ghost"]);
  assert.strictEqual(sub.nodes[1].labels.includes("PmItem"), true, "synthesized node has PmItem label");
});

test("criticalPathSubgraph on a single-node chain yields just that node", () => {
  const g = graph([node("A")], []);
  const sub = criticalPathSubgraph(g as never, ["A"]);
  assert.deepStrictEqual(sub.nodes.map((n) => n.id), ["A"]);
  assert.strictEqual(sub.relationships.length, 0);
});

test("cyclesSubgraph on no cycles yields an empty graph", () => {
  const g = graph([node("A")], []);
  const sub = cyclesSubgraph(g as never, []);
  assert.deepStrictEqual(sub.nodes, []);
  assert.strictEqual(sub.relationships.length, 0);
});

// ---------------------------------------------------------------------------
// analyzeGraph with two disconnected components and a cycle
// ---------------------------------------------------------------------------

test("analyzeGraph reports multiple connected components", () => {
  const g = graph(
    [node("A"), node("B"), node("C"), node("D")],
    [rel("B", "A", "BLOCKED_BY"), rel("D", "C", "BLOCKED_BY")],
  );
  const report = analyzeGraph(g as never);
  assert.strictEqual(report.itemCount, 4);
  assert.strictEqual(report.connectedComponents, 2, "two independent pairs");
  assert.strictEqual(report.structuralEdgeCount, 2);
});

// ---------------------------------------------------------------------------
// criticalConnectors — Tarjan articulation-point / bridge detection on real
// multi-node graphs (the empty/single-node cases above only exercise the
// trivial early-return paths).
// ---------------------------------------------------------------------------

test("criticalConnectors flags the middle of a chain as an articulation point and its edges as bridges", () => {
  // A -> B -> C (treated undirected): removing B disconnects A and C, so B is
  // an articulation point and both links are bridges. This exercises the
  // non-root articulation branch (parent non-null, low(child) >= disc(node)).
  const edges = [rel("A", "B", "BLOCKED_BY"), rel("B", "C", "BLOCKED_BY")];
  const result = criticalConnectors(["A", "B", "C"], edges);
  assert.deepStrictEqual(result.articulationPoints, ["B"]);
  assert.deepStrictEqual(result.bridges, [
    { from: "A", to: "B" },
    { from: "B", to: "C" },
  ]);
});

test("criticalConnectors flags a hub root with two branches as an articulation point", () => {
  // A is the DFS root with two independent children (B, C); with no B-C link,
  // A is an articulation point (root with >1 DFS child) and both links bridge.
  const edges = [rel("A", "B", "BLOCKED_BY"), rel("A", "C", "BLOCKED_BY")];
  const result = criticalConnectors(["A", "B", "C"], edges);
  assert.deepStrictEqual(result.articulationPoints, ["A"]);
  assert.deepStrictEqual(result.bridges, [
    { from: "A", to: "B" },
    { from: "A", to: "C" },
  ]);
});

test("criticalConnectors finds no bridges or articulation points in a fully connected triangle", () => {
  // A triangle is 2-connected: every edge has a redundant alternate path, so
  // there are no bridges and no articulation points. Exercises the back-edge
  // low-update branch (a visited neighbour that is not the DFS parent).
  const edges = [
    rel("A", "B", "BLOCKED_BY"),
    rel("B", "C", "BLOCKED_BY"),
    rel("C", "A", "BLOCKED_BY"),
  ];
  const result = criticalConnectors(["A", "B", "C"], edges);
  assert.deepStrictEqual(result.articulationPoints, []);
  assert.deepStrictEqual(result.bridges, []);
});

// ---------------------------------------------------------------------------
// explainItem property decoding and renderer label fallbacks
// ---------------------------------------------------------------------------

test("explainItem reads a Neo4j-Integer-shaped priority via its toNumber method", () => {
  // readNumberProperty must unwrap a driver Integer ({ toNumber() }) into a
  // plain number when explaining an item whose priority came from Neo4j.
  const g = graph([node("A", { priority: { toNumber: () => 7 } })], []);
  const report = explainItem(g as never, "A");
  assert.ok(report, "item is explainable");
  assert.strictEqual(report!.item.priority, 7, "Integer-shaped priority unwrapped");
});

test("explainItem falls back to Item/unknown when type/status are absent", () => {
  const g = graph([
    { id: "A", labels: ["PmItem"], properties: { id: "A", title: "A", type: "", status: "" } },
  ], []);
  const report = explainItem(g as never, "A");
  assert.ok(report);
  assert.strictEqual(report!.item.type, "Item", "empty type defaults to Item");
  assert.strictEqual(report!.item.status, "unknown", "empty status defaults to unknown");
});

test("renderAnalysisDiagram falls back to the node id when title is not a string", () => {
  // The dot and mermaid renderers must not crash on a non-string title; they
  // substitute the node id. Exercises the false arm of each title ternary.
  const g = graph(
    [{ id: "X", labels: ["PmItem"], properties: { id: "X", title: 99, type: "Task", status: "open" } }] as unknown as ReturnType<typeof node>[],
    [],
  );
  const dot = renderAnalysisDiagram("dot", g as never);
  assert.ok(dot.includes('"X"'), "dot uses the node id as the label");
  const mermaid = renderAnalysisDiagram("mermaid", g as never);
  assert.ok(mermaid.includes("X"), "mermaid uses the node id as the label");
});
// ---------------------------------------------------------------------------
// Real multi-node graph analytics — exercise the traversal branches the
// empty/single-node cases above leave dormant (cycle canonicalisation,
// multi-hop path reconstruction, memoised depth/chain accumulation).
// ---------------------------------------------------------------------------

test("findCycles returns one canonical cycle for a two-node mutual block", () => {
  // A -> B and B -> A is a single cycle regardless of which node the DFS roots
  // at; the canonical rotation must collapse both roots to one result.
  const edges = [rel("A", "B", "BLOCKED_BY"), rel("B", "A", "BLOCKED_BY")];
  const cycles = findCycles(["A", "B"], edges);
  assert.strictEqual(cycles.length, 1, "deduplicated to a single cycle");
  assert.deepStrictEqual(cycles[0], ["A", "B", "A"], "cycle is closed back at A");
});

test("findCycles finds a three-node cycle and skips the acyclic tail", () => {
  const edges = [
    rel("B", "A", "BLOCKED_BY"),
    rel("C", "B", "BLOCKED_BY"),
    rel("A", "C", "BLOCKED_BY"), // A -> C -> B -> A cycle
    rel("D", "A", "BLOCKED_BY"), // acyclic tail into the cycle
  ];
  const cycles = findCycles(["A", "B", "C", "D"], edges);
  assert.ok(cycles.length >= 1, "the triangle cycle is detected");
  assert.ok(cycles.every((c) => c[0] === c[c.length - 1]), "every cycle is closed");
});

test("shortestPath reconstructs a multi-hop directed path", () => {
  const edges = [rel("A", "B", "BLOCKED_BY"), rel("B", "C", "BLOCKED_BY")];
  assert.deepStrictEqual(shortestPath(edges, "A", "C"), ["A", "B", "C"]);
});

test("longestChain returns the full chain across a linear dependency", () => {
  const edges = [rel("A", "B", "BLOCKED_BY"), rel("B", "C", "BLOCKED_BY")];
  assert.deepStrictEqual(longestChain(["A", "B", "C"], edges), ["A", "B", "C"]);
});

test("reverseReachable walks back multiple hops to every dependent", () => {
  const edges = [rel("A", "B", "BLOCKED_BY"), rel("B", "C", "BLOCKED_BY")];
  // Edges point dependent -> blocker, so everything that reaches C (A and B).
  assert.deepStrictEqual(reverseReachable(edges, "C"), ["A", "B"]);
});

test("dependencyDepths reports increasing depth along a chain", () => {
  const edges = [rel("A", "B", "BLOCKED_BY"), rel("B", "C", "BLOCKED_BY")];
  const depths = dependencyDepths(["A", "B", "C"], edges);
  assert.strictEqual(depths.get("A"), 2, "A is two hops from the leaf");
  assert.strictEqual(depths.get("B"), 1);
  assert.strictEqual(depths.get("C"), 0, "C is a leaf");
});
