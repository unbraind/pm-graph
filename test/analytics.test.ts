import assert from "node:assert/strict";
import test from "node:test";

import {
  findCycles,
  shortestPath,
  longestChain,
  analyzeGraph,
  renderGraphml,
  renderPlantuml,
  topoSort,
  reverseReachable,
  dependencyDepths,
  criticalConnectors,
  projectSubgraph,
  criticalPathSubgraph,
  cyclesSubgraph,
  renderAnalysisDiagram,
  explainItem,
  parseNodeFilter,
  matchesNodeFilter,
} from "../dist/index.js";

// The renderers and analytics helpers are exported from the compiled module.
// We import the renderExport-backed formats indirectly by exercising the
// exported pure helpers plus a small in-module check for graphml/plantuml via
// the exporter is covered by smoke; here we test the analytics math and the
// two new renderers' shape through analyzeGraph + direct helper calls.

type Edge = { from: string; to: string; type: string };

const chainEdges: Edge[] = [
  { from: "D", to: "C", type: "BLOCKED_BY" },
  { from: "C", to: "B", type: "BLOCKED_BY" },
  { from: "B", to: "A", type: "BLOCKED_BY" },
];

const cycleEdges: Edge[] = [
  { from: "E", to: "F", type: "BLOCKED_BY" },
  { from: "F", to: "E", type: "BLOCKED_BY" },
];

test("findCycles detects a simple 2-node cycle", () => {
  const cycles = findCycles(["E", "F"], cycleEdges);
  assert.strictEqual(cycles.length, 1, "should find exactly one cycle");
  const c = cycles[0];
  assert.strictEqual(c[0], c[c.length - 1], "cycle path is closed");
  assert.deepStrictEqual([...new Set(c)].sort(), ["E", "F"]);
});

test("findCycles returns nothing on an acyclic chain", () => {
  const cycles = findCycles(["A", "B", "C", "D"], chainEdges);
  assert.deepStrictEqual(cycles, []);
});

test("findCycles detects a longer 3-node cycle and de-dupes rotations", () => {
  const edges: Edge[] = [
    { from: "X", to: "Y", type: "BLOCKED_BY" },
    { from: "Y", to: "Z", type: "BLOCKED_BY" },
    { from: "Z", to: "X", type: "BLOCKED_BY" },
  ];
  const cycles = findCycles(["X", "Y", "Z"], edges);
  assert.strictEqual(cycles.length, 1, "rotations should collapse to one cycle");
  assert.strictEqual(cycles[0].length, 4, "3-node cycle has 4 entries (closed)");
});

test("shortestPath finds the directed path along a chain", () => {
  const path = shortestPath(chainEdges, "D", "A");
  assert.deepStrictEqual(path, ["D", "C", "B", "A"]);
});

test("shortestPath returns single-node for from === to", () => {
  assert.deepStrictEqual(shortestPath(chainEdges, "B", "B"), ["B"]);
});

test("shortestPath returns null when no directed path exists", () => {
  // chain is directed D->C->B->A; A cannot reach D
  assert.strictEqual(shortestPath(chainEdges, "A", "D"), null);
});

test("shortestPath picks the shortest of multiple routes", () => {
  const edges: Edge[] = [
    { from: "S", to: "M", type: "BLOCKED_BY" },
    { from: "M", to: "T", type: "BLOCKED_BY" },
    { from: "S", to: "T", type: "RELATED" },
  ];
  assert.deepStrictEqual(shortestPath(edges, "S", "T"), ["S", "T"]);
});

test("longestChain returns the full chain", () => {
  const chain = longestChain(["A", "B", "C", "D"], chainEdges);
  assert.deepStrictEqual(chain, ["D", "C", "B", "A"]);
});

test("longestChain is cycle-safe (terminates, no infinite loop)", () => {
  const chain = longestChain(["E", "F"], cycleEdges);
  // Either [E,F] or [F,E] depending on iteration; length must be finite and <= node count.
  assert.ok(chain.length >= 1 && chain.length <= 2, `got length ${chain.length}`);
});

// --- analyzeGraph integration over a synthetic Graph ----------------------

function node(id: string, extra: Record<string, unknown> = {}) {
  return { id, labels: ["PmItem"], properties: { id, title: id, type: "Task", status: "open", ...extra } };
}
function rel(from: string, to: string, type: string) {
  return { from, to, type, properties: {} };
}

const syntheticGraph = {
  generatedAt: "2026-06-02T00:00:00.000Z",
  workspace: "/tmp/ws",
  projectKey: "ws",
  nodes: [
    node("A"), node("B"), node("C"), node("D"),
    node("E"), node("F"), node("O"),
    // facet node should be ignored by analytics
    { id: "status:open", labels: ["PmFacet", "Status"], properties: { id: "status:open", title: "open" } },
  ],
  relationships: [
    rel("B", "A", "BLOCKED_BY"),
    rel("C", "B", "BLOCKED_BY"),
    rel("D", "C", "BLOCKED_BY"),
    rel("E", "F", "BLOCKED_BY"),
    rel("F", "E", "BLOCKED_BY"),
    // facet/tag edges must NOT affect analytics
    rel("A", "status:open", "HAS_STATUS"),
    rel("B", "tag:backend", "TAGGED_WITH"),
  ],
};

test("analyzeGraph computes the expected health metrics", () => {
  const report = analyzeGraph(syntheticGraph as any);
  assert.strictEqual(report.itemCount, 7, "7 PmItem nodes (facet excluded)");
  assert.strictEqual(report.structuralEdgeCount, 5, "5 structural edges (facet/tag excluded)");
  assert.strictEqual(report.cycleCount, 1, "one cycle E<->F");
  assert.deepStrictEqual(report.orphans, ["O"], "O is the only orphan");
  // Edges point item -> blocker (B --BLOCKED_BY--> A). So D (no incoming) is a
  // root and A (no outgoing) is a leaf.
  assert.ok(report.roots.includes("D"), "D is a root (no incoming dep)");
  assert.ok(report.leaves.includes("A"), "A is a leaf (no outgoing dep)");
  assert.strictEqual(report.longestChainLength, 4, "chain D->C->B->A has length 4");
  assert.deepStrictEqual(report.longestChain, ["D", "C", "B", "A"]);
  // components: {A,B,C,D}, {E,F}, {O} = 3
  assert.strictEqual(report.connectedComponents, 3);
  assert.deepStrictEqual(report.blockedItems.sort(), ["B", "C", "D", "E", "F"]);
  assert.ok(report.topDegreeCentrality.length > 0);
  assert.deepStrictEqual(report.articulationPoints, ["B", "C"]);
  assert.ok(report.bridgeEdges.some((e: { from: string; to: string }) => e.from === "A" && e.to === "B"));
});

test("analyzeGraph ignores facet/tag edges entirely", () => {
  const report = analyzeGraph(syntheticGraph as any);
  // If facet edges leaked in, A would gain an outgoing edge (to status:open)
  // and structuralEdgeCount would be 7 instead of 5.
  assert.strictEqual(report.structuralEdgeCount, 5);
  assert.ok(report.leaves.includes("A"), "A stays a leaf without facet edges");
});

test("explainItem reports blockers/dependents/impact for an acyclic item", () => {
  const report = explainItem(syntheticGraph as any, "B");
  assert.ok(report, "item should be explainable");
  assert.strictEqual(report!.id, "B");
  assert.deepStrictEqual(report!.blockers.map((n) => n.id), ["A"]);
  assert.deepStrictEqual(report!.dependents.map((n) => n.id), ["C"]);
  assert.deepStrictEqual(report!.transitiveDependents, ["C", "D"]);
  assert.strictEqual(report!.dependencyDepth, 1);
  assert.deepStrictEqual(report!.criticalChainFromItem, ["B", "A"]);
  assert.strictEqual(report!.inCycle, false);
  assert.strictEqual(report!.cycleCount, 0);
});

test("explainItem reports cycle participation for a cyclic item", () => {
  const report = explainItem(syntheticGraph as any, "E");
  assert.ok(report, "item should be explainable");
  assert.strictEqual(report!.inCycle, true);
  assert.strictEqual(report!.cycleCount, 1);
  assert.deepStrictEqual([...new Set(report!.cycles[0])].sort(), ["E", "F"]);
  assert.deepStrictEqual(report!.blockers.map((n) => n.id), ["F"]);
  assert.deepStrictEqual(report!.dependents.map((n) => n.id), ["F"]);
});

test("explainItem returns null for unknown item ids", () => {
  assert.strictEqual(explainItem(syntheticGraph as any, "missing-id"), null);
});

// --- renderers ------------------------------------------------------------

const renderGraph = {
  generatedAt: "2026-06-02T00:00:00.000Z",
  workspace: "/tmp/ws",
  projectKey: "ws",
  nodes: [
    node("A", { title: 'Quote "X" & <Y>' }),
    node("B"),
  ],
  relationships: [rel("B", "A", "BLOCKED_BY")],
};

test("renderGraphml emits valid, escaped GraphML", () => {
  const xml = renderGraphml(renderGraph as any);
  assert.ok(xml.startsWith('<?xml version="1.0"'), "has XML prolog");
  assert.ok(xml.includes("<graphml"), "has graphml root");
  assert.ok(xml.includes('edgedefault="directed"'), "directed graph");
  assert.ok(xml.includes('<node id="A">'), "node A present");
  assert.ok(xml.includes('source="B" target="A"'), "edge present");
  assert.ok(xml.includes("Quote &quot;X&quot; &amp; &lt;Y&gt;"), "title is XML-escaped");
  assert.ok(xml.trim().endsWith("</graphml>"), "closes graphml");
});

test("renderPlantuml emits a valid @startuml block", () => {
  const uml = renderPlantuml(renderGraph as any);
  assert.ok(uml.startsWith("@startuml"), "starts with @startuml");
  assert.ok(uml.trim().endsWith("@enduml"), "ends with @enduml");
  assert.ok(uml.includes("object "), "declares objects");
  assert.ok(/n_A\b/.test(uml) && /n_B\b/.test(uml), "aliases sanitized");
  assert.ok(uml.includes("--> n_A : BLOCKED_BY"), "edge with rel-type label");
  assert.ok(!uml.includes('"X"') || uml.includes("'X'"), "double-quotes neutralized in labels");
});

// --- topoSort -------------------------------------------------------------

test("topoSort orders dependencies before dependents on a chain", () => {
  // D->C->B->A (each blocked by the next). A has no prereqs, must come first;
  // D depends on everything, must come last.
  const { order, cycleNodes } = topoSort(["A", "B", "C", "D"], chainEdges);
  assert.deepStrictEqual(cycleNodes, [], "acyclic: no cycle nodes");
  assert.deepStrictEqual(order, ["A", "B", "C", "D"]);
  // every edge from->to must have `to` appear before `from`
  for (const e of chainEdges) {
    assert.ok(order.indexOf(e.to) < order.indexOf(e.from), `${e.to} before ${e.from}`);
  }
});

test("topoSort is deterministic (ties broken by ascending id)", () => {
  // Two independent roots Y and X both blocked by Z. Z first, then X, then Y.
  const edges: Edge[] = [
    { from: "Y", to: "Z", type: "BLOCKED_BY" },
    { from: "X", to: "Z", type: "BLOCKED_BY" },
  ];
  const { order } = topoSort(["X", "Y", "Z"], edges);
  assert.deepStrictEqual(order, ["Z", "X", "Y"]);
});

test("topoSort reports cycle nodes and a resolvable prefix", () => {
  // G->A->... acyclic part plus E<->F cycle.
  const edges: Edge[] = [
    { from: "G", to: "H", type: "BLOCKED_BY" },
    ...cycleEdges, // E<->F
  ];
  const { order, cycleNodes } = topoSort(["E", "F", "G", "H"], edges);
  assert.deepStrictEqual(cycleNodes, ["E", "F"], "E and F are unresolvable");
  // H has no prereqs, G depends on H; both resolvable.
  assert.deepStrictEqual(order, ["H", "G"]);
});

// --- reverseReachable -----------------------------------------------------

test("reverseReachable finds all transitive dependents", () => {
  // D->C->B->A means A is depended on by B,C,D transitively.
  assert.deepStrictEqual(reverseReachable(chainEdges, "A"), ["B", "C", "D"]);
  assert.deepStrictEqual(reverseReachable(chainEdges, "C"), ["D"]);
  assert.deepStrictEqual(reverseReachable(chainEdges, "D"), [], "D has no dependents");
});

test("reverseReachable is cycle-safe", () => {
  const impacted = reverseReachable(cycleEdges, "E");
  // F is reachable backwards from E; E excludes itself; must terminate.
  assert.deepStrictEqual(impacted, ["F"]);
});

// --- dependencyDepths -----------------------------------------------------

test("dependencyDepths computes longest path to a leaf per node", () => {
  const depths = dependencyDepths(["A", "B", "C", "D"], chainEdges);
  assert.strictEqual(depths.get("A"), 0, "leaf depth 0");
  assert.strictEqual(depths.get("B"), 1);
  assert.strictEqual(depths.get("C"), 2);
  assert.strictEqual(depths.get("D"), 3, "far end of the chain");
});

test("dependencyDepths is cycle-safe", () => {
  const depths = dependencyDepths(["E", "F"], cycleEdges);
  // must terminate; each depth finite and <= node count
  assert.ok((depths.get("E") ?? 0) >= 0 && (depths.get("E") ?? 0) <= 2);
  assert.ok((depths.get("F") ?? 0) >= 0 && (depths.get("F") ?? 0) <= 2);
});

test("analyzeGraph exposes maxDepth and depthByItem", () => {
  const report = analyzeGraph(syntheticGraph as any);
  // chain D->C->B->A gives maxDepth 3 (D), and depthByItem sorted deepest-first.
  assert.strictEqual(report.maxDepth, 3, "D sits 3 edges from leaf A");
  assert.strictEqual(report.depthByItem[0].id, "D");
  assert.strictEqual(report.depthByItem[0].depth, 3);
  const byId = new Map(report.depthByItem.map((d: { id: string; depth: number }) => [d.id, d.depth]));
  assert.strictEqual(byId.get("A"), 0);
  assert.strictEqual(byId.get("O"), 0, "orphan depth 0");
});

test("criticalConnectors finds articulation points and bridge edges in the undirected structural projection", () => {
  const result = criticalConnectors(["A", "B", "C", "D"], chainEdges);
  assert.deepStrictEqual(result.articulationPoints, ["B", "C"]);
  assert.deepStrictEqual(result.bridges, [
    { from: "A", to: "B" },
    { from: "B", to: "C" },
    { from: "C", to: "D" },
  ]);

  const triangle: Edge[] = [
    { from: "A", to: "B", type: "BLOCKED_BY" },
    { from: "B", to: "C", type: "BLOCKED_BY" },
    { from: "C", to: "A", type: "BLOCKED_BY" },
  ];
  const noSingleConnector = criticalConnectors(["A", "B", "C"], triangle);
  assert.deepStrictEqual(noSingleConnector.articulationPoints, []);
  assert.deepStrictEqual(noSingleConnector.bridges, []);
});

// --- analysis diagram subgraphs (critical-path / cycles --format) ---------

// A graph with a 4-node dependency chain D->C->B->A, a separate E<->F cycle,
// an orphan O, and facet/tag noise that must never leak into the subgraphs.
const diagramGraph = {
  generatedAt: "2026-06-02T00:00:00.000Z",
  workspace: "/tmp/ws",
  projectKey: "ws",
  nodes: [
    node("A"), node("B"), node("C"), node("D"),
    node("E"), node("F"), node("O"),
    { id: "status:open", labels: ["PmFacet", "Status"], properties: { id: "status:open", title: "open" } },
  ],
  relationships: [
    rel("D", "C", "BLOCKED_BY"),
    rel("C", "B", "BLOCKED_BY"),
    rel("B", "A", "BLOCKED_BY"),
    rel("E", "F", "BLOCKED_BY"),
    rel("F", "E", "BLOCKED_BY"),
    rel("A", "status:open", "HAS_STATUS"),
    rel("B", "tag:backend", "TAGGED_WITH"),
  ],
};

test("criticalPathSubgraph contains exactly the chain nodes and connecting edges", () => {
  const chain = longestChain(["A", "B", "C", "D"], chainEdges); // D,C,B,A
  const sub = criticalPathSubgraph(diagramGraph as any, chain);
  assert.deepStrictEqual(sub.nodes.map((n: any) => n.id), ["D", "C", "B", "A"]);
  assert.strictEqual(sub.relationships.length, 3, "three consecutive chain edges");
  for (const r of sub.relationships) {
    assert.strictEqual(r.type, "BLOCKED_BY");
  }
  // No cycle node, orphan, or facet node may appear.
  for (const id of ["E", "F", "O", "status:open"]) {
    assert.ok(!sub.nodes.some((n: any) => n.id === id), `${id} excluded`);
  }
});

test("critical-path --format mermaid emits a mermaid graph with exactly the chain nodes", () => {
  const chain = longestChain(["A", "B", "C", "D"], chainEdges);
  const out = renderAnalysisDiagram("mermaid", criticalPathSubgraph(diagramGraph as any, chain));
  assert.ok(out.startsWith("graph TD"), "is a mermaid graph");
  for (const id of ["A", "B", "C", "D"]) {
    assert.ok(out.includes(`n_${id}[`), `chain node ${id} present`);
  }
  for (const id of ["E", "F", "O"]) {
    assert.ok(!new RegExp(`\\bn_${id}\\b`).test(out), `non-chain node ${id} absent`);
  }
  // Exactly the three chain edges, in chain order, no facet/tag edges.
  const edgeLines = out.split("\n").filter((l) => l.includes("-->"));
  assert.deepStrictEqual(edgeLines.map((l) => l.trim()), [
    "n_D -->|BLOCKED_BY| n_C",
    "n_C -->|BLOCKED_BY| n_B",
    "n_B -->|BLOCKED_BY| n_A",
  ]);
});

test("cyclesSubgraph contains only cycle-participating nodes and edges", () => {
  const edges = [...chainEdges, ...cycleEdges];
  const cycles = findCycles(["A", "B", "C", "D", "E", "F"], edges);
  const sub = cyclesSubgraph(diagramGraph as any, cycles);
  assert.deepStrictEqual([...sub.nodes.map((n: any) => n.id)].sort(), ["E", "F"]);
  assert.strictEqual(sub.relationships.length, 2, "the two edges around the E<->F cycle");
  for (const id of ["A", "B", "C", "D", "O", "status:open"]) {
    assert.ok(!sub.nodes.some((n: any) => n.id === id), `${id} excluded`);
  }
});

test("cycles --format graphml emits only the cycle-participating nodes/edges", () => {
  const edges = [...chainEdges, ...cycleEdges];
  const cycles = findCycles(["A", "B", "C", "D", "E", "F"], edges);
  const xml = renderAnalysisDiagram("graphml", cyclesSubgraph(diagramGraph as any, cycles));
  assert.ok(xml.startsWith('<?xml version="1.0"'), "is GraphML");
  assert.ok(xml.includes('<node id="E">') && xml.includes('<node id="F">'), "both cycle nodes present");
  for (const id of ["A", "B", "C", "D", "O"]) {
    assert.ok(!xml.includes(`<node id="${id}">`), `non-cycle node ${id} absent`);
  }
  // Exactly two edges, both directed E<->F, no facet/tag edges.
  const edgeCount = (xml.match(/<edge /g) ?? []).length;
  assert.strictEqual(edgeCount, 2, "exactly the two cycle edges");
  assert.ok(xml.includes('source="E" target="F"') && xml.includes('source="F" target="E"'));
});

test("projectSubgraph never invents edges absent from the source graph", () => {
  // Ask for an edge key (A->D) that does not exist among structural edges.
  const sub = projectSubgraph(diagramGraph as any, ["A", "D"], ["A->D"]);
  assert.deepStrictEqual(sub.nodes.map((n: any) => n.id), ["A", "D"]);
  assert.strictEqual(sub.relationships.length, 0, "no fabricated edge");
});

test("renderAnalysisDiagram on the chain subgraph equals renderGraphml of the same subgraph (renderer reuse)", () => {
  const chain = longestChain(["A", "B", "C", "D"], chainEdges);
  const sub = criticalPathSubgraph(diagramGraph as any, chain);
  assert.strictEqual(renderAnalysisDiagram("graphml", sub), renderGraphml(sub as any));
});

// --- --format dot (Graphviz) for analysis diagrams -------------------------

test("critical-path --format dot emits a Graphviz digraph with exactly the chain nodes", () => {
  const chain = longestChain(["A", "B", "C", "D"], chainEdges);
  const out = renderAnalysisDiagram("dot", criticalPathSubgraph(diagramGraph as any, chain));
  assert.ok(out.startsWith("digraph pm_graph {"), "is a Graphviz digraph");
  assert.ok(out.trim().endsWith("}"), "closes the digraph");
  for (const id of ["A", "B", "C", "D"]) {
    assert.ok(out.includes(`"${id}" [label=`), `chain node ${id} present`);
  }
  for (const id of ["E", "F", "O"]) {
    assert.ok(!new RegExp(`"${id}" \\[label=`).test(out), `non-chain node ${id} absent`);
  }
  // Exactly the three chain edges in chain order, directed with BLOCKED_BY labels.
  const edgeLines = out.split("\n").filter((l) => l.includes("->")).map((l) => l.trim());
  assert.deepStrictEqual(edgeLines, [
    '"D" -> "C" [label="BLOCKED_BY"];',
    '"C" -> "B" [label="BLOCKED_BY"];',
    '"B" -> "A" [label="BLOCKED_BY"];',
  ]);
});

test("cycles --format dot emits only the cycle-participating nodes/edges as a digraph", () => {
  const edges = [...chainEdges, ...cycleEdges];
  const cycles = findCycles(["A", "B", "C", "D", "E", "F"], edges);
  const out = renderAnalysisDiagram("dot", cyclesSubgraph(diagramGraph as any, cycles));
  assert.ok(out.startsWith("digraph pm_graph {"), "is a Graphviz digraph");
  assert.ok(out.includes('"E" [label=') && out.includes('"F" [label='), "both cycle nodes present");
  for (const id of ["A", "B", "C", "D", "O"]) {
    assert.ok(!new RegExp(`"${id}" \\[label=`).test(out), `non-cycle node ${id} absent`);
  }
  const edgeLines = out.split("\n").filter((l) => l.includes("->")).map((l) => l.trim());
  assert.deepStrictEqual(edgeLines, [
    '"E" -> "F" [label="BLOCKED_BY"];',
    '"F" -> "E" [label="BLOCKED_BY"];',
  ]);
});

test("renderAnalysisDiagram dot output is structurally distinct from mermaid and graphml", () => {
  const chain = longestChain(["A", "B", "C", "D"], chainEdges);
  const sub = criticalPathSubgraph(diagramGraph as any, chain);
  const dot = renderAnalysisDiagram("dot", sub);
  const mermaid = renderAnalysisDiagram("mermaid", sub);
  const graphml = renderAnalysisDiagram("graphml", sub);
  assert.ok(dot.startsWith("digraph"), "dot starts with digraph");
  assert.ok(mermaid.startsWith("graph TD"), "mermaid starts with graph TD");
  assert.ok(graphml.startsWith("<?xml"), "graphml starts with xml prolog");
  assert.notStrictEqual(dot, mermaid);
  assert.notStrictEqual(dot, graphml);
});

// --- --filter (node filtering by type/status) -----------------------------

test("parseNodeFilter parses key=value and comma-separated value lists", () => {
  assert.deepStrictEqual(parseNodeFilter(["type=Task"]), [{ key: "type", values: ["task"] }]);
  assert.deepStrictEqual(parseNodeFilter(["status=open,done"]), [
    { key: "status", values: ["open", "done"] },
  ]);
  // Multiple terms accumulate (AND across entries).
  assert.deepStrictEqual(parseNodeFilter(["type=Task", "status=open"]), [
    { key: "type", values: ["task"] },
    { key: "status", values: ["open"] },
  ]);
  // Repeating a single-valued key extends its OR set instead of creating an
  // impossible status=open AND status=in_progress condition.
  assert.deepStrictEqual(parseNodeFilter(["status=open", "status=in_progress,open"]), [
    { key: "status", values: ["open", "in_progress"] },
  ]);
  // Whitespace and case are normalised.
  assert.deepStrictEqual(parseNodeFilter(["  TYPE = Epic , Story "]), [
    { key: "type", values: ["epic", "story"] },
  ]);
});

test("parseNodeFilter rejects malformed terms and unsupported keys", () => {
  assert.throws(() => parseNodeFilter(["Task"]), /Invalid --filter/);
  assert.throws(() => parseNodeFilter(["=Task"]), /Invalid --filter/);
  assert.throws(() => parseNodeFilter(["priority=high"]), /Invalid --filter key "priority"/);
  assert.throws(() => parseNodeFilter(["type="]), /Invalid --filter/);
  assert.throws(() => parseNodeFilter(["type=,,"]), /Invalid --filter/);
});

test("matchesNodeFilter keeps non-PmItem nodes and respects AND/OR semantics", () => {
  const item = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    labels: ["PmItem"],
    properties: { id, title: id, type: "Task", status: "open", ...extra },
  });
  const facet = { id: "status:open", labels: ["PmFacet", "Status"], properties: { id: "status:open", title: "open" } };

  // Empty filter: everything survives.
  assert.strictEqual(matchesNodeFilter(item("A") as any, []), true);
  assert.strictEqual(matchesNodeFilter(facet as any, []), true);

  // Single entry: PmItem matching type survives, non-matching drops.
  assert.strictEqual(matchesNodeFilter(item("A") as any, parseNodeFilter(["type=Task"])), true);
  assert.strictEqual(matchesNodeFilter(item("A", { type: "Epic" }) as any, parseNodeFilter(["type=Task"])), false);

  // Comma-list is OR within a key.
  assert.strictEqual(matchesNodeFilter(item("A", { type: "Epic" }) as any, parseNodeFilter(["type=Task,Epic"])), true);

  // Multiple entries are AND across keys.
  assert.strictEqual(
    matchesNodeFilter(item("A") as any, parseNodeFilter(["type=Task", "status=open"])),
    true,
  );
  assert.strictEqual(
    matchesNodeFilter(item("A", { status: "done" }) as any, parseNodeFilter(["type=Task", "status=open"])),
    false,
  );

  // Non-PmItem nodes always survive the filter.
  assert.strictEqual(matchesNodeFilter(facet as any, parseNodeFilter(["type=Task"])), true);

  // Matching is case-insensitive on the property value.
  assert.strictEqual(matchesNodeFilter(item("A", { status: "Open" }) as any, parseNodeFilter(["status=open"])), true);
});
