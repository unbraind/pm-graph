/** Crash/source-update state machine uses real SDK items and an independent transactional sink model. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { graphFromItems, refreshEventProjection, readEventProjection, readEventProjectionReceipt, validateEventProjection } from "../src/index.ts";
import { parseProjectionSourceHead } from "../src/event-projection.ts";
import type { Graph, ProjectionDelta, ProjectionSink, ProjectionSinkPosition } from "../src/index.ts";
import type { ItemMetadata, UpdateCommandOptions } from "@unbrained/pm-cli/sdk";
import { authoritative, comparable, fixture, seed } from "./event-projection-helpers.ts";
import { publicChildEnv } from "./fixtures/public-child-env.ts";
import { FOREIGN_CHECKPOINTS, clearProjectionHistory } from "./event-projection-recovery-corpus.ts";

/** Apply only the sink contract; no package storage, delta producer or normalization is reused. */
function sinkModel() {
  let position: ProjectionSinkPosition | null = null;
  const nodes = new Map<string, Graph["nodes"][number]>();
  const edges = new Map<string, Graph["relationships"][number]>();
  const audit: string[] = [];
  const foreign = { node: { id: "foreign", title: "peer data" }, edge: { type: "PEER", token: "untouched" } };
  const edgeId = (edge: Graph["relationships"][number]): string => JSON.stringify([edge.from, edge.to, edge.type]);
  const sink: ProjectionSink = {
    key: "post-action-model",
    inspect: async () => position && structuredClone(position),
    apply: async (delta: ProjectionDelta) => {
      assert.deepEqual(parseProjectionSourceHead(JSON.stringify(delta.sourceHead)), delta.sourceHead);
      if (position?.revision === delta.revision) return "already_applied";
      if ((position?.revision ?? null) !== delta.expected) return "conflict";
      if (delta.rebuild) { nodes.clear(); edges.clear(); }
      for (const id of delta.removeNodes) nodes.delete(id);
      for (const edge of delta.removeEdges) edges.delete(edgeId(edge));
      for (const node of delta.nodes) nodes.set(node.id, structuredClone(node));
      for (const edge of delta.edges) edges.set(edgeId(edge), structuredClone(edge));
      position = { revision: delta.revision, sourceHead: structuredClone(delta.sourceHead) };
      audit.push(delta.revision);
      return "applied";
    },
  };
  return { sink, foreign, audit, nodes, edges, position: () => position, setPosition: (value: ProjectionSinkPosition | null) => { position = value; } };
}

/** Explicitly clear every relationship/scope field in title-only SDK model mutations. */
async function updateTitle(f: ReturnType<typeof fixture>, id: string, title: string): Promise<void> {
  await f.client.update(id, { title, unset: ["parent", "assignee", "reviewer", "sprint", "release", "blocked_by", "blocked_reason"], clearDeps: true });
}
/** Inject a post-commit loss without mocking any SDK read or write. */
async function crashAfterCommit(options: Parameters<typeof refreshEventProjection>[0]): Promise<void> {
  assert.equal((await refreshEventProjection({ ...options, onTransition: (phase) => { if (phase === "afterSink") throw new Error("crash"); } })).ok, false);
}

test("legacy CAS sink recovers committed work after later source mutations", async () => {
  for (const rebuild of [false, true]) {
    const f = fixture();
    try {
      const a = await seed(f.client, "committed"); const b = await seed(f.client, "later");
      const model = sinkModel();
      // Pre-recovery SDK clients expose only the original atomic CAS contract.
      const legacy: ProjectionSink = { key: model.sink.key, apply: (delta) => model.sink.apply({ ...delta, sourceHead: delta.sourceHead ?? {} }) };
      const options = { pmRoot: f.pmRoot, stateFile: f.stateFile, sink: legacy };
      assert.equal((await refreshEventProjection(options)).ok, true);
      await f.client.update(a, { title: "sink committed", blockedBy: b, unset: ["parent", "assignee", "reviewer", "sprint", "release", "blocked_reason"], clearDeps: true });
      const before = readFileSync(f.stateFile, "utf8");
      const crashed = await refreshEventProjection({ ...options, onTransition: (phase) => { if (phase === "afterSink") throw new Error("lost checkpoint"); } });
      assert.equal(crashed.ok, false); assert.equal(readFileSync(f.stateFile, "utf8"), before);
      await f.client.update(b, { title: "source advanced", unset: ["parent", "assignee", "reviewer", "sprint", "release", "blocked_by", "blocked_reason"], clearDeps: true });
      const recovered = await refreshEventProjection({ ...options, rebuild });
      assert.equal(recovered.ok, true, `committed sink must recover after source advancement: ${JSON.stringify(recovered)}`);
      assert.equal(recovered.fullScans, rebuild ? 1 : 0);
      const state = await readEventProjection(f.stateFile); assert.ok(state);
      assert.deepEqual(comparable({ ...state.graph, nodes: [...model.nodes.values()], relationships: [...model.edges.values()] }), comparable(state.graph));
      for (const id of [a, b]) assert.equal(state.graph.nodes.find((node) => node.id === id)?.properties.title, (await authoritative(f.pmRoot, id)).title);
    } finally { rmSync(f.ws, { recursive: true, force: true }); }
  }
});

test("500 post-action crash sequences converge after 0-3 source updates through native SDK read-back", async () => {
  const f = fixture();
  try {
    await f.client.schemaAddType("ExternalPmItem");
    const statuses = ["active", "blocked", "terminal_done", "terminal_canceled"].map((role, index) => `recovery_${index}_175`);
    for (let i = 0; i < statuses.length; i++) await f.client.schemaAddStatus(statuses[i], { role: [i === 0 ? "active" : i === 1 ? "blocked" : i === 2 ? "terminal_done" : "terminal_canceled"] });
    const a = await seed(f.client, "recovery-a", "ExternalPmItem"); const b = await seed(f.client, "recovery-b");
    const reference = new Map<string, ItemMetadata>();
    for (const id of [a, b]) reference.set(id, await authoritative(f.pmRoot, id));
    let randomState = 0x175004;
    const random = (bound: number): number => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState % bound; };
    const oldInputs: UpdateCommandOptions[] = [];
    const mutate = async (sequence: number, step: number): Promise<void> => {
      const linked = random(2) === 0;
      const input: UpdateCommandOptions = { title: `  recovery ${sequence} ${step}\r\n value ${random(80)}  `,
        type: random(2) ? "ExternalPmItem" : "Task", status: statuses[random(statuses.length)], priority: random(5),
        tags: `tag${random(4)}, Tag ${random(4)}`, deadline: `2027-02-${String(1 + random(28)).padStart(2, "0")}`,
        ...(linked ? { parent: b, blockedBy: b, blockedReason: `reason ${random(9)}\r\ncontinued`, assignee: "owner", reviewer: "reviewer", sprint: "sprint", release: "release", dep: [`id=${b},kind=related_to`], replaceDeps: true }
          : { unset: ["parent", "blocked_by", "blocked_reason", "assignee", "reviewer", "sprint", "release"], clearDeps: true }) };
      const replay = step >= 0 && oldInputs.length > 0 && random(5) === 0 ? oldInputs[random(oldInputs.length)] : input;
      await f.client.update(a, replay);
      oldInputs.push(input);
      reference.set(a, await authoritative(f.pmRoot, a));
    };
    for (let sequence = 0; sequence < 500; sequence++) {
      const phase = (["afterSink", "checkpoint", "receipt"] as const)[sequence < 48 ? sequence % 3 : random(3)];
      const updates = sequence < 48 ? Math.floor(sequence / 3) % 4 : random(4);
      const rebuild = (sequence < 48 ? Math.floor(sequence / 12) % 2 : random(2)) === 1;
      const admission = (sequence < 48 ? Math.floor(sequence / 24) % 2 : random(2)) === 1;
      rmSync(f.stateFile, { force: true }); rmSync(f.stateFile + ".pending.json", { force: true });
      const model = sinkModel(); const foreignBefore = JSON.stringify(model.foreign);
      const options = { pmRoot: f.pmRoot, stateFile: f.stateFile, sink: model.sink };
      await f.client.focus(random(2) ? a : b);
      if (!admission) assert.equal((await refreshEventProjection(options)).ok, true);
      await mutate(sequence, -1);
      let crashed = false;
      const failure = await refreshEventProjection({ ...options, onTransition: (current) => { if (current === phase) { crashed = true; throw new Error("post-action crash"); } } });
      assert.equal(crashed, true, `seed 0x175004 sequence ${sequence} phase ${phase}`);
      assert.equal(failure.ok, false);
      assert.ok(model.position()?.revision);
      assert.equal(existsSync(f.stateFile + ".pending.json"), true);
      const committed = model.position()?.revision;
      for (let update = 0; update < updates; update++) await mutate(sequence, update);
      const auditBefore = [...model.audit];
      const result = await refreshEventProjection({ ...options, rebuild });
      assert.equal(result.ok, true, `seed 0x175004 sequence ${sequence} ${phase} updates=${updates} rebuild=${rebuild}: ${JSON.stringify(result)}`);
      assert.equal(result.fullScans, rebuild ? 1 : 0);
      if (!rebuild && updates === 0) assert.equal(result.revision, committed);
      assert.deepEqual(model.audit.slice(0, auditBefore.length), auditBefore, "recovery retains every successful action");
      const state = await readEventProjection(f.stateFile); assert.ok(state);
      assert.equal(validateEventProjection(JSON.parse(readFileSync(f.stateFile, "utf8"))), true);
      const expected = graphFromItems([...reference.values()].sort((x, y) => x.id.localeCompare(y.id)), "projection", new Map());
      assert.deepEqual(comparable(state.graph), comparable(expected));
      assert.deepEqual(comparable({ ...state.graph, nodes: [...model.nodes.values()], relationships: [...model.edges.values()] }), comparable(expected));
      assert.equal((await readEventProjectionReceipt(f.stateFile, 1000)).revision, model.position()?.revision);
      assert.equal(JSON.stringify(model.foreign), foreignBefore);
      if (sequence % 100 === 99) console.log(JSON.stringify({ postActionSequences: sequence + 1, seed: "0x175004" }));
    }
  } finally { rmSync(f.ws, { recursive: true, force: true }); }
});

test("source-known recovery without cached intent discloses rebuild; unknown source refuses until explicit rebuild", async () => {
  const f = fixture();
  try {
    const id = await seed(f.client, "marker"); const model = sinkModel();
    const options = { pmRoot: f.pmRoot, stateFile: f.stateFile, sink: model.sink };
    assert.equal((await refreshEventProjection(options)).ok, true);
    await updateTitle(f, id, "committed");
    await crashAfterCommit(options);
    rmSync(f.stateFile + ".pending.json");
    const rebuilt = await refreshEventProjection(options);
    assert.equal(rebuilt.ok, true); assert.equal(rebuilt.mode, "rebuild"); assert.equal(rebuilt.fullScans, 1);
    assert.match(rebuilt.reason!, /known sink history/);
    const marker = model.position()!;
    model.setPosition({ revision: "f".repeat(64), sourceHead: { ...marker.sourceHead, anchor: { item_id: id, version: 1, hash: "0".repeat(64) } } });
    const before = readFileSync(f.stateFile, "utf8"); const audit = [...model.audit];
    assert.equal((await refreshEventProjection(options)).refusal?.code, "SINK_CONFLICT");
    assert.equal(readFileSync(f.stateFile, "utf8"), before); assert.deepEqual(model.audit, audit);
    const repaired = await refreshEventProjection({ ...options, rebuild: true });
    assert.equal(repaired.ok, true, JSON.stringify(repaired)); assert.equal(repaired.fullScans, 1);
    assert.equal((await readEventProjection(f.stateFile))?.base, "f".repeat(64));
  } finally { rmSync(f.ws, { recursive: true, force: true }); }
});

test("empty admitted history and opaque sink revisions recover without inventing event coordinates", async () => {
  for (const rebuild of [false, true]) {
    const f = fixture();
    try {
      clearProjectionHistory(f.pmRoot);
      const model = sinkModel(); const options = { pmRoot: f.pmRoot, stateFile: f.stateFile, sink: model.sink };
      await crashAfterCommit(options);
      assert.deepEqual(model.position()?.sourceHead, {});
      const id = await seed(f.client, "after-empty-commit");
      const recovered = await refreshEventProjection({ ...options, rebuild });
      assert.equal(recovered.ok, true, JSON.stringify(recovered)); assert.equal(recovered.fullScans, rebuild ? 1 : 0);
      assert.equal((await readEventProjection(f.stateFile))?.graph.nodes.find((node) => node.id === id)?.properties.title, (await authoritative(f.pmRoot, id)).title);
      model.setPosition({ revision: "opaque-peer-revision" });
      assert.equal((await refreshEventProjection(options)).refusal?.code, "SINK_CONFLICT");
      assert.equal((await refreshEventProjection({ ...options, rebuild: true })).ok, true);
      assert.match((await readEventProjection(f.stateFile))!.base!, /^[a-f0-9]{64}$/);
    } finally { rmSync(f.ws, { recursive: true, force: true }); }
  }
});

test("foreign recovery records and malformed source coordinates fail alone before sink inspection", async () => {
  const f = fixture();
  try {
    await seed(f.client, "foreign-intent");
    const options = { pmRoot: f.pmRoot, stateFile: f.stateFile, sink: { key: "must-not-inspect", inspect: async () => { assert.fail("foreign intent must refuse before target access"); }, apply: async () => { assert.fail("foreign intent must refuse before action"); } } };
    for (const bytes of FOREIGN_CHECKPOINTS) for (const rebuild of [false, true]) {
      writeFileSync(f.stateFile + ".pending.json", bytes);
      assert.equal((await refreshEventProjection({ ...options, rebuild })).refusal?.code, "FOREIGN_STATE");
      assert.equal(readFileSync(f.stateFile + ".pending.json", "utf8"), bytes);
    }
    for (const value of [null, [], { cursor: "x" }, { anchor: {} }, { cursor: "x", anchor: { item_id: "x", version: Infinity, hash: "f".repeat(64) } }, '{'])
      assert.equal(parseProjectionSourceHead(value), null);
    assert.deepEqual(parseProjectionSourceHead("\r\n {} \r\n"), {});
    assert.deepEqual(publicChildEnv({ PATH: "fixture-bin", NPM_TOKEN: "synthetic", NODE_AUTH_TOKEN: "synthetic", NPM_MEDIA_SERVER: "synthetic", EXAMPLE_API_KEY: "synthetic" }), { PATH: "fixture-bin" });
  } finally { rmSync(f.ws, { recursive: true, force: true }); }
});


test("marker boundary failures and competing post-inspection commits never report stale recovery success", async () => {
  const f = fixture();
  try {
    const id = await seed(f.client, "boundary"); const model = sinkModel();
    const options = { pmRoot: f.pmRoot, stateFile: f.stateFile, sink: model.sink };
    assert.equal((await refreshEventProjection(options)).ok, true);
    const crash = async (title: string): Promise<void> => {
      await updateTitle(f, id, title);
      await crashAfterCommit(options);
    };
    await crash("boundary committed");
    const before = readFileSync(f.stateFile, "utf8");
    for (const raw of [undefined, false, 0, [], {}, { revision: "" }, { revision: Infinity }, { revision: null, foreign: true }, { revision: "x", sourceHead: { cursor: "missing-anchor" } }, "conflict"]) {
      const sink: ProjectionSink = { key: model.sink.key, inspect: async () => raw as ProjectionSinkPosition, apply: async () => { assert.fail("invalid marker must skip dependent writes"); } };
      assert.equal((await refreshEventProjection({ ...options, sink })).refusal?.code, "SINK_CONFLICT");
      assert.equal(readFileSync(f.stateFile, "utf8"), before);
    }
    const unavailable: ProjectionSink = { key: model.sink.key, inspect: async () => { throw new Error("unavailable"); }, apply: model.sink.apply };
    assert.equal((await refreshEventProjection({ ...options, sink: unavailable })).refusal?.code, "SINK_UNAVAILABLE");
    const legacyUnavailable: ProjectionSink = { key: model.sink.key, apply: async () => { throw new Error("unavailable"); } };
    assert.equal((await refreshEventProjection({ ...options, sink: legacyUnavailable })).refusal?.code, "SINK_UNAVAILABLE");
    const position = model.position()!; assert.ok(position.sourceHead?.anchor);
    const { anchor, cursor } = position.sourceHead;
    const reordered: ProjectionSink = { ...model.sink, inspect: async () => ({ revision: position.revision, sourceHead: { anchor: { hash: anchor.hash, version: anchor.version, item_id: anchor.item_id }, cursor } }) };
    assert.equal((await refreshEventProjection({ ...options, sink: reordered })).fullScans, 0, "both sides use the producer's source-head normalization");
    await crash("newer committed");
    const committedBeforeRace = model.position()!.revision; assert.ok(committedBeforeRace);
    const raced: ProjectionSink = { ...model.sink, inspect: async () => {
      const observed = await model.sink.inspect!("");
      assert.ok(observed && observed !== "conflict");
      model.setPosition({ ...observed, revision: "e".repeat(64) });
      return observed;
    } };
    assert.equal((await refreshEventProjection({ ...options, sink: raced })).refusal?.code, "SINK_CONFLICT", "even recovered no-ops must revalidate the current target");
    assert.equal(model.position()?.revision, "e".repeat(64));
    assert.equal((await readEventProjection(f.stateFile))?.revision, committedBeforeRace, "a later refusal retains the verified earlier sink success");
    assert.ok(model.audit.includes(committedBeforeRace));
    assert.equal((await refreshEventProjection({ ...options, rebuild: true })).ok, true);
  } finally { rmSync(f.ws, { recursive: true, force: true }); }
});
