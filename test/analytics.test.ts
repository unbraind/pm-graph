import assert from "node:assert/strict";
import test from "node:test";

import {
  findCycles,
  shortestPath,
  longestChain,
  analyzeGraph,
  renderGraphml,
  renderPlantuml,
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
});

test("analyzeGraph ignores facet/tag edges entirely", () => {
  const report = analyzeGraph(syntheticGraph as any);
  // If facet edges leaked in, A would gain an outgoing edge (to status:open)
  // and structuralEdgeCount would be 7 instead of 5.
  assert.strictEqual(report.structuralEdgeCount, 5);
  assert.ok(report.leaves.includes("A"), "A stays a leaf without facet edges");
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
