/** User type labels never confer synthetic-node provenance on authoritative SDK items. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deleteItem } from "@unbrained/pm-cli/sdk";
import { contractionInputFromGraph, contractGraph, refreshEventProjection } from "../src/index.ts";
import type { Graph, ProjectionSink } from "../src/index.ts";
import { assertFull, cli, comparable, fixture, seed } from "./event-projection-helpers.ts";
import { installBuiltGraphExtension, makeHarness } from "./helpers.ts";

test("authoritative contribution identity wins across type collisions, reference order, sparse sink updates and delete/restore", async () => {
  const f = fixture();
  try {
    const types = ["ExternalPmItem", "PmItem", "PmFacet", "Status", "Tag"];
    for (const type of types) await f.client.schemaAddType(type);
    const a = await seed(f.client, "a", types[0]);
    const b = await seed(f.client, "b");
    const c = await seed(f.client, "c", types[0]);
    await f.client.update(a, { parent: c, blockedBy: c, dep: [`id=${c},kind=related_to`, "id=sparse-missing,kind=related_to"], allowUnresolvedDeps: true, replaceDeps: true });
    await f.client.update(b, { parent: a, blockedBy: a, dep: [`id=${a},kind=related_to`], replaceDeps: true });
    const sinkNodes = new Map<string, Graph["nodes"][number]>();
    let revision: string | null = null;
    const sink: ProjectionSink = { key: "provenance-sink", apply: async (delta) => {
      assert.equal(delta.expected, revision);
      for (const id of delta.removeNodes) sinkNodes.delete(id);
      for (const node of delta.nodes) sinkNodes.set(node.id, node);
      revision = delta.revision;
      return "applied";
    } };
    const options = { pmRoot: f.pmRoot, stateFile: f.stateFile, sink };
    for (const type of types) {
      await f.client.update(a, { type, title: `  authoritative ${type}\r\n next  `, tags: "kept", priority: 1 });
      const result = await refreshEventProjection(options);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.fullScans, type === types[0] ? 1 : 0);
      const state = await assertFull(options);
      assert.deepEqual([...sinkNodes.values()].sort((x, y) => x.id.localeCompare(y.id)), [...state.graph.nodes].sort((x, y) => x.id.localeCompare(y.id)));
      for (const includeFacets of [true, false]) {
        const graph = includeFacets ? state.graph : { ...state.graph, nodes: state.graph.nodes.filter((n) => !n.id.includes(":")) };
        const input = contractionInputFromGraph(graph, [a, b], ["CHILD_OF", "BLOCKED_BY", "RELATED_TO"]);
        assert.deepEqual(input.nodes.filter((node) => node.unknown).map((node) => node.id), ["sparse-missing"]);
        const contracted = contractGraph(input); assert.ok(contracted.ok);
        assert.equal(contracted.receipt.unknown, 1);
      }
    }
    await deleteItem(c, { force: true }, { pmRoot: f.pmRoot, noExtensions: true, author: "graph-test" });
    assert.equal((await refreshEventProjection(options)).ok, true);
    let state = await assertFull(options);
    assert.deepEqual(state.graph.nodes.find((n) => n.id === c)?.labels, ["ExternalPmItem"]);
    await f.client.restore(c, "1");
    assert.equal((await refreshEventProjection(options)).ok, true);
    state = await assertFull(options);
    assert.deepEqual(state.graph.nodes.find((n) => n.id === c)?.labels, ["PmItem", "ExternalPmItem"]);
    assert.equal((await refreshEventProjection({ ...options, rebuild: true })).ok, true);
    assert.deepEqual(comparable((await assertFull(options)).graph), comparable(state.graph));
  } finally { rmSync(f.ws, { recursive: true, force: true }); }
});

test("custom ExternalPmItem survives real no-git refresh, export and contraction CLI JSON/TOON paths", async () => {
  const f = fixture();
  try {
    await f.client.schemaAddType("ExternalPmItem");
    const a = await seed(f.client, "a", "ExternalPmItem");
    const b = await seed(f.client, "b");
    await f.client.update(b, { parent: a, blockedBy: a, dep: [`id=${a},kind=related_to`], replaceDeps: true });
    installBuiltGraphExtension(f.pmRoot);
    const adapter = await makeHarness();
    const emptyPath = join(f.ws, "no-git"); mkdirSync(emptyPath);
    const hostEnv = { ...process.env, PM_PATH: "", PATH: emptyPath, GIT_CEILING_DIRECTORIES: tmpdir() };
    const run = (args: string[], json: boolean): string => {
      const result = spawnSync(process.execPath, [cli, "pm-graph", ...args, ...(json ? ["--json"] : [])], {
        cwd: f.ws, env: hostEnv, encoding: "utf8", timeout: 30000,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result.stdout;
    };
    for (const json of [true, false]) {
      for (const flags of [[], ["--rebuild"]]) {
        await f.client.update(a, { title: `CLI authoritative ${json} ${flags.length}` });
        run(["refresh", "projection.json", ...flags], json);
        const state = await assertFull(f);
        run(["refresh", "projection.json", "--receipt"], json);
        const exported = join(f.ws, "export.json");
        run(["export", "--format", "json", "--include-closed", "--output", exported], json);
        const adapted = join(f.ws, "adapter.json");
        await adapter.runExporter({ exporter: "graph-export", options: { format: "json", output: adapted }, pmRoot: f.pmRoot });
        assert.deepEqual(JSON.parse(readFileSync(adapted, "utf8")).graph.nodes, JSON.parse(readFileSync(exported, "utf8")).graph.nodes);
        const document = JSON.parse(readFileSync(exported, "utf8")) as { graph: {
          nodes: { id: string; labels: string[]; metadata: Record<string, unknown> }[];
          edges: { source: string; target: string; relation: string; metadata: Record<string, unknown> }[];
        } };
        assert.deepEqual(comparable({ ...state.graph,
          nodes: document.graph.nodes.map(({ id, labels, metadata }) => ({ id, labels, properties: metadata })),
          relationships: document.graph.edges.map(({ source, target, relation, metadata }) => ({ from: source, to: target, type: relation, properties: metadata })),
        }), comparable(state.graph));
        const output = run(["contract", a, b, "--edges", "CHILD_OF,BLOCKED_BY,RELATED_TO"], json);
        if (json) assert.equal(JSON.parse(output).receipt.unknown, 0);
        else assert.match(output, /unknown: 0/);
      }
    }
    assert.equal(JSON.parse(run(["status"], true)).localItemCount, 2);
  } finally { rmSync(f.ws, { recursive: true, force: true }); }
});
