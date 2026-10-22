import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import {
  analyzeGraph, criticalPathSubgraph, cyclesSubgraph, explainItem,
  graphFromItems, impactSubgraph, impactSubgraphFromNodeSet, projectSubgraph,
  renderAnalysisDiagram,
} from "../src/index.ts";
import type { ExplainReport, Graph } from "../src/index.ts";
import { captureStdout, collectHandlers, synthNode, synthRel } from "./helpers.ts";

/** Raw host storage: C blocks B, and B blocks A. */
function inverseChain(): Graph {
  return { workspace: ".", projectKey: "fixture", generatedAt: "fixture",
    nodes: ["A", "B", "C"].map((id) => synthNode(id)),
    relationships: [synthRel("B", "A", "BLOCKS"), synthRel("C", "B", "BLOCKS")] };
}

test("README filter support matches the seven analytics command help contracts", async () => {
  const handlers = collectHandlers();
  const supported = ["analyze", "cycles", "critical-path", "topo-sort", "path", "impact", "explain"];
  for (const name of supported) {
    const help = await handlers.get(`pm-graph ${name}`)!({ args: ["--help"] }) as { flags: Record<string, string> };
    assert.ok(Object.keys(help.flags).some((flag) => flag.startsWith("--filter")), name);
  }
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const sentence = readme.split(". ").find((part) => part.includes("accept `--filter type=...|status=...`"));
  assert.ok(sentence, "README must state which commands accept --filter");
  const documented = [...sentence.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  assert.deepEqual(documented, [...supported, "--filter type=...|status=..."]);
  const refused = await handlers.get("pm-graph blocker-cuts")!({ args: ["goal", "--filter", "status=open"] }) as { code: string };
  assert.equal(refused.code, "INVALID_OPTIONS");
});

test("BLOCKS analytics identify the waiting item without mutating stored relationships", () => {
  const graph = inverseChain();
  // Equivalent inverse and forward rows must not fabricate a dependency cycle.
  graph.relationships.push(synthRel("A", "B", "BLOCKED_BY"), { ...graph.relationships[0] });
  const before = structuredClone(graph);
  const report = explainItem(graph, "B")!;
  assert.deepEqual(report.blockers.map((row) => [row.id, row.relationTypes]), [["C", ["BLOCKS"]]]);
  assert.deepEqual(report.dependents.map((row) => [row.id, row.relationTypes]), [["A", ["BLOCKED_BY", "BLOCKS"]]]);
  assert.deepEqual(report.transitiveDependents, ["A"]);
  assert.deepEqual(report.criticalChainFromItem, ["B", "C"]);
  assert.equal(report.dependencyDepth, 1);
  assert.equal(report.inCycle, false);
  const analysis = analyzeGraph(graph);
  assert.deepEqual(analysis.longestChain, ["A", "B", "C"]);
  assert.deepEqual(analysis.roots, ["A"]);
  assert.deepEqual(analysis.leaves, ["C"]);
  assert.deepEqual(analysis.blockedItems, ["A", "B"]);
  assert.equal(analysis.cycleCount, 0);
  assert.deepEqual(analysis.depthByItem, [{ id: "A", depth: 2 }, { id: "B", depth: 1 }, { id: "C", depth: 0 }]);
  assert.deepEqual(graph, before);
});

test("mixed BLOCKS and BLOCKED_BY cycles retain every raw cycle relationship", () => {
  const graph = inverseChain();
  graph.relationships.push(synthRel("C", "A", "BLOCKED_BY"));
  const cycles = analyzeGraph(graph).cycles;
  assert.deepEqual(cycles, [["A", "B", "C", "A"]]);
  assert.deepEqual(explainItem(graph, "B")!.cycles, cycles);
  assert.deepEqual(cyclesSubgraph(graph, cycles).relationships, graph.relationships);
});

test("BLOCKS analysis diagrams select dependency keys and render stored endpoints", () => {
  const graph = inverseChain();
  const original = structuredClone(graph);
  graph.relationships.push(synthRel("B", "A", "RELATED"));
  graph.relationships[0].properties = { source: "fixture" };
  const sub = criticalPathSubgraph(graph, ["A", "B", "C"]);
  assert.deepEqual(sub.relationships, graph.relationships.slice(0, 2));
  assert.match(renderAnalysisDiagram("dot", sub), /"B" -> "A"/);
  assert.doesNotMatch(renderAnalysisDiagram("dot", sub), /"A" -> "B"/);
  // Public projection keys default to stored directions; impact paths are bidirectional.
  assert.deepEqual(projectSubgraph(original, ["A", "B"], ["A->B"]).relationships, []);
  assert.deepEqual(projectSubgraph(original, ["A", "B"], ["B->A"]).relationships, [original.relationships[0]]);
  assert.deepEqual(impactSubgraphFromNodeSet(original, "C", ["A", "B"]).relationships, original.relationships);
  assert.deepEqual(impactSubgraph(original, "C", [{ id: "A", path: ["C", "B", "A"] }]).relationships, original.relationships);
});

test("real non-git tracker BLOCKS commands agree on prerequisite order, paths and impact", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "analytics-direction-"));
  const pmRoot = join(workspace, ".agents", "pm");
  const cli = resolve(import.meta.dirname, "../node_modules/@unbrained/pm-cli/dist/cli.js");
  try {
    const initialized = spawnSync(process.execPath, [cli, "--pm-path", pmRoot, "--no-extensions", "init", "--defaults", "--agent-guidance", "skip", "--prefix", "direction"], {
      cwd: workspace, encoding: "utf8", timeout: 120_000,
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(existsSync(join(workspace, ".git")), false);
    const client = new PmClient({ pmRoot, noExtensions: true, author: "contract-test" });
    const a = (await client.create({ type: "Task", title: "Waiting goal" })).item.id;
    const b = (await client.create({ type: "Task", title: "Intermediate", dep: [`id=${a},kind=blocks`] })).item.id;
    const c = (await client.create({ type: "Task", title: "Prerequisite", dep: [`id=${b},kind=blocks`] })).item.id;
    const handlers = collectHandlers();
    const run = (name: string, args: string[] = []) => handlers.get(`pm-graph ${name}`)!({ pm_root: pmRoot, args });
    assert.deepEqual((await run("topo-sort") as { order: string[] }).order, [c, b, a]);
    assert.deepEqual((await run("path", [a, c]) as { path: string[] }).path, [a, b, c]);
    assert.equal((await run("path", [c, a]) as { found: boolean }).found, false);
    assert.deepEqual((await run("critical-path") as { path: string[] }).path, [a, b, c]);
    assert.deepEqual((await run("explain", [a]) as ExplainReport).blockers.map((row) => row.id), [b]);
    assert.deepEqual((await run("impact", [c, "--include-closed"]) as { impacted: string[] }).impacted, [a, b].sort());
    const diagram = await captureStdout(() => run("critical-path", ["--format", "dot"]));
    assert.ok(diagram.stdout.includes(`"${b}" -> "${a}"`));
    const snapshot = await client.listAllComplete({});
    const projected = graphFromItems(snapshot.items, ".", new Map());
    assert.ok(projected.relationships.some((rel) => rel.from === b && rel.to === a && rel.type === "BLOCKS"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
