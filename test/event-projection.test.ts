import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deleteItem, getHistoryPath, getItemPath, serializeItemDocument } from "@unbrained/pm-cli/sdk";
import type { ItemMetadata, UpdateCommandOptions } from "@unbrained/pm-cli/sdk";
import { EVENT_PROJECTION_PHASES, graphFromItems, refreshEventProjection, readEventProjection, readEventProjectionReceipt, validateEventProjection } from "../src/index.ts";
import type { Graph, EventProjectionOptions, ProjectionDelta, EventProjectionReceipt, EventProjectionState } from "../src/index.ts";
import { collectHandlers, installBuiltGraphExtension } from "./helpers.ts";

import { main as validationMain, validateEventProjectionCorpus } from "../scripts/validate-event-projection.ts";
import { cli, fixture, seed, comparable, authoritative, assertFull } from "./event-projection-helpers.ts";

test("admission, sparse updates, exact stored receipt pages, replay, deletion and no git executable", async () => {
  const f = fixture();
  const beforePath = process.env.PATH;
  try {
    const a = await seed(f.client, "a");
    const b = await seed(f.client, "b");
    await f.client.update(a, { blockedBy: b, tags: "one", unset: ["parent", "assignee", "sprint", "release"], dep: [`id=${b},kind=related_to`], replaceDeps: true });
    const admitted = await refreshEventProjection({ pmRoot: f.pmRoot, stateFile: f.stateFile });
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    assert.equal(admitted.fullScans, 1);
    const initial = await assertFull(f);
    await f.client.update(a, { title: "  Changed\r\n title ", tags: "two", unset: ["parent", "blocked_by", "blocked_reason", "assignee", "sprint", "release"], clearDeps: true });
    const emptyPath = join(f.ws, "no-git"); mkdirSync(emptyPath);
    process.env.PATH = emptyPath;
    const sparse = await refreshEventProjection({ pmRoot: f.pmRoot, stateFile: f.stateFile, limit: 1 });
    process.env.PATH = beforePath;
    assert.equal(sparse.ok, true, JSON.stringify(sparse));
    assert.equal(sparse.fullScans, 0); assert.equal(sparse.itemReads, 1); assert.equal(sparse.projectedItems, 1);
    assert.notEqual(sparse.revision, initial.revision);
    const recovered = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await readEventProjectionReceipt(f.stateFile, 1, offset);
      recovered.push(...page.work); offset = page.nextOffset ?? null;
    }
    assert.equal(recovered.length, sparse.totalWork);
    assert.equal(recovered.filter((row) => row.kind === "edge" && row.type === "BLOCKED_BY").length, 1);
    await assertFull(f);
    const noop = await refreshEventProjection({ pmRoot: f.pmRoot, stateFile: f.stateFile });
    assert.equal(noop.itemReads, 0); assert.equal(noop.revision, sparse.revision);
    await deleteItem(b, { force: true }, { pmRoot: f.pmRoot, noExtensions: true, author: "graph-test" });
    const deleted = await refreshEventProjection({ pmRoot: f.pmRoot, stateFile: f.stateFile });
    assert.equal(deleted.ok, true, JSON.stringify(deleted));
    await assertFull(f);
  } finally { process.env.PATH = beforePath; rmSync(f.ws, { recursive: true, force: true }); }
});

test("seeded model: 500 operation sequences read SDK state, replay older inputs, whitespace, relationships and native fields", async () => {
  const f = fixture();
  try {
    let randomState = 0x261027;
    const random = (bound: number): number => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState % bound; };
    const parent = await seed(f.client, "root", "Feature");
    const types = ["Task", "ExternalPmItem", "PmFacet", "Status", "PmItem"];
    for (const type of types.slice(1)) await f.client.schemaAddType(type);
    const statuses = Array.from({ length: 4 }, (_, index) => `custom_${random(10000)}_${index}`);
    for (const status of statuses) await f.client.schemaAddStatus(status, { role: ["active"] });
    const ids = [];
    for (let i = 0; i < 5; i++) { await f.client.focus(parent); ids.push(await seed(f.client, `item${i}`, types[i])); }
    const model = new Map<string, ItemMetadata>();
    for (const id of [parent, ...ids]) model.set(id, await authoritative(f.pmRoot, id));
    const inputs: Array<{ id: string; options: UpdateCommandOptions }> = [];
    const sinkNodes = new Map<string, Graph["nodes"][number]>();
    const sinkEdges = new Map<string, Graph["relationships"][number]>();
    let sinkRevision: string | null = null;
    const relationKey = (edge: Graph["relationships"][number]): string => JSON.stringify([edge.from, edge.to, edge.type]);
    const sink = { key: "model-sink", apply: async (delta: ProjectionDelta): Promise<"applied" | "already_applied" | "conflict"> => {
      if (delta.revision === sinkRevision) return "already_applied";
      if (delta.expected !== sinkRevision) return "conflict";
      for (const id of delta.removeNodes) sinkNodes.delete(id);
      for (const edge of delta.removeEdges) sinkEdges.delete(relationKey(edge));
      for (const node of delta.nodes) sinkNodes.set(node.id, node);
      for (const edge of delta.edges) sinkEdges.set(relationKey(edge), edge);
      sinkRevision = delta.revision; return "applied";
    } };
    const modelOptions = { pmRoot: f.pmRoot, stateFile: f.stateFile, sink };
    const first = await refreshEventProjection(modelOptions); assert.equal(first.ok, true, JSON.stringify(first));
    for (let sequence = 0; sequence < 500; sequence++) {
      for (let op = 0; op < 2 + random(3); op++) {
        const id = ids[random(ids.length)];
        const target = ids[(ids.indexOf(id) + 1 + random(ids.length - 1)) % ids.length];
        const withScope = random(2) === 0;
        const update: UpdateCommandOptions = { title: `  value ${random(80)}${random(2) ? "\r\n" : "\n"}continued  `, type: types[random(types.length)], status: statuses[random(statuses.length)],
          priority: random(5), tags: `tag${random(4)}, Tag ${random(4)}`, deadline: `2027-01-${String(1 + random(28)).padStart(2, "0")}`,
          ...(withScope ? { parent, blockedBy: target, blockedReason: `reason ${random(8)}\r\nnext`, assignee: `agent${random(4)}`, sprint: `s${random(3)}`, release: `r${random(3)}` }
            : { unset: ["parent", "blocked_by", "blocked_reason", "assignee", "sprint", "release"] }),
          ...(random(2) ? { dep: [`id=${target},kind=related_to`], replaceDeps: true } : { clearDeps: true }) };
        const input = inputs.length && random(4) === 0 ? inputs[random(inputs.length)] : { id, options: update };
        await f.client.update(input.id, input.options);
        model.set(input.id, await authoritative(f.pmRoot, input.id));
        inputs.push({ id, options: update });
      }
      const receipt = await refreshEventProjection(modelOptions);
      assert.equal(receipt.ok, true, `seed 0x261027 sequence ${sequence}: ${JSON.stringify(receipt)}`);
      assert.equal(receipt.fullScans, 0);
      const state = await readEventProjection(f.stateFile); assert.ok(state);
      assert.equal(validateEventProjection(JSON.parse(JSON.stringify(state))), true);
      assert.deepEqual(comparable(state.graph), comparable(graphFromItems([...model.values()].sort((a, b) => a.id.localeCompare(b.id)), "projection", new Map())), `seed 0x261027 sequence ${sequence}`);
      assert.deepEqual(comparable({ ...state.graph, nodes: [...sinkNodes.values()], relationships: [...sinkEdges.values()] }), comparable(state.graph));
      if (sequence % 50 === 0) await assertFull(f);
    }
    await assertFull(f);
  } finally { rmSync(f.ws, { recursive: true, force: true }); }
});

test("foreign checkpoints and malformed dense/finite boundary inputs fail alone", async () => {
  const f = fixture();
  try {
    for (const patch of [{ limit: Infinity }, { limit: NaN }, { offset: -1 }, { maxEvents: 0 }, { maxEvents: 1000001 }, { unknown: 1 }, { rebuild: 1 }, { pmRoot: "" }, { sink: {} }]) {
      assert.equal((await refreshEventProjection({ pmRoot: f.pmRoot, stateFile: f.stateFile, ...patch } as EventProjectionOptions)).refusal?.code, "INVALID_INPUT");
    }
    const validOptions = { pmRoot: f.pmRoot, stateFile: f.stateFile };
    writeFileSync(f.stateFile, '{"foreign":true}');
    for (const rebuild of [false, true]) assert.equal((await refreshEventProjection({ ...validOptions, rebuild })).refusal?.code, "FOREIGN_STATE");
    assert.equal(readFileSync(f.stateFile, "utf8"), '{"foreign":true}');
    rmSync(f.stateFile);
    assert.equal((await refreshEventProjection(validOptions)).ok, true);
    const valid = await readEventProjection(f.stateFile); assert.ok(valid);
    const invalid: unknown[] = [null, {}, { ...valid, revision: "x" }, { ...valid, version: 2 }, { ...valid, extra: 1 }, { ...valid, contributions: new Array(1) }, { ...valid, graph: { ...valid.graph, nodes: new Array(1) } }, { ...valid, versions: { x: Infinity } }];
    for (const input of invalid) assert.equal(validateEventProjection(input), false);
    for (const extreme of [NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE]) {
      const bad: EventProjectionState = structuredClone(valid); bad.receipt.nodes = extreme;
      assert.equal(validateEventProjection(bad), false);
    }
    const badJson = join(f.ws, "bad.json"); writeFileSync(badJson, "{");
    assert.equal(await readEventProjection(badJson), null);
    assert.equal((await readEventProjectionReceipt(badJson)).refusal?.code, "FOREIGN_STATE");
    assert.equal((await readEventProjectionReceipt(badJson, 0)).refusal?.code, "INVALID_INPUT");
  } finally { rmSync(f.ws, { recursive: true, force: true }); }
});

test("lost anchors and workspace changes disclose refusal and explicit certified rebuild", async () => {
  const f = fixture();
  try {
    const id = await seed(f.client, "anchor");
    const initial = await refreshEventProjection({ pmRoot: f.pmRoot, stateFile: f.stateFile }); assert.equal(initial.ok, true, JSON.stringify(initial));
    const saved = readFileSync(f.stateFile, "utf8");
    const historyPath = getHistoryPath(f.pmRoot, id);
    const original = readFileSync(historyPath, "utf8");
    writeFileSync(historyPath, "");
    const refused = await refreshEventProjection({ pmRoot: f.pmRoot, stateFile: f.stateFile });
    assert.equal(refused.refusal?.code, "CURSOR_GAP");
    assert.equal(readFileSync(f.stateFile, "utf8"), saved);
    writeFileSync(historyPath, original);
    await f.client.schemaAddStatus("arbitrary_active", { role: ["active"] });
    assert.equal((await refreshEventProjection({ pmRoot: f.pmRoot, stateFile: f.stateFile })).refusal?.code, "CURSOR_GAP");
    const rebuilt = await refreshEventProjection({ pmRoot: f.pmRoot, stateFile: f.stateFile, rebuild: true });
    assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt)); assert.equal(rebuilt.mode, "rebuild");
    await assertFull(f);
  } finally { rmSync(f.ws, { recursive: true, force: true }); }
});

test("real command host preserves compact JSON/TOON and refuses invalid arguments", async () => {
  const f = fixture();
  try {
    await seed(f.client, "cli");
    await seed(f.client, "cli-second");
    const run = collectHandlers().get("pm-graph refresh")!;
    const ctx = { pm_root: f.pmRoot, cwd: f.ws };
    assert.ok(await run({ ...ctx, args: ["--help"] }));
    for (const args of [[], ["--wat"], ["one", "two"], ["one", "--limit"], ["one", "--limit", "oops"], ["one", "--offset", "-1"]]) {
      assert.equal((await run({ ...ctx, args }) as EventProjectionReceipt).refusal?.code, "INVALID_INPUT");
    }
    const validation = await validateEventProjectionCorpus(f.pmRoot, join(f.ws, "public-checkpoint.json"));
    assert.equal(validation.authoritativeSourceUnchanged, true);
    await validationMain([f.pmRoot, join(f.ws, "another-checkpoint.json")]);
    await assert.rejects(validationMain([]), /Supply a public tracker/);
    installBuiltGraphExtension(f.pmRoot);
    const command = (args: string[]) => spawnSync(process.execPath, [cli, "pm-graph", "refresh", "projection.json", ...args], { cwd: f.ws, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir(), PM_PATH: "" } });
    const json = command(["--json"]); assert.equal(json.status, 0, json.stdout + json.stderr);
    assert.equal(JSON.parse(json.stdout).fullScans, 1);
    const toon = command([]); assert.equal(toon.status, 0, toon.stdout + toon.stderr); assert.match(toon.stdout, /fullScans: 0/);
    const page = command(["--receipt", "--limit", "1", "--offset", "1", "--json"]); assert.equal(page.status, 0, page.stdout + page.stderr); assert.equal(JSON.parse(page.stdout).work.length, 1);
    const fail = command(["--limit", "Infinity", "--json"]); assert.equal(fail.status, 2, fail.stdout + fail.stderr);
  } finally { rmSync(f.ws, { recursive: true, force: true }); }
});

test("each storage transition revalidates a competing refresher on the same non-git tracker", async () => {
  const f = fixture();
  try {
    const id = await seed(f.client, "race");
    const options = { pmRoot: f.pmRoot, stateFile: f.stateFile };
    for (const boundary of EVENT_PROJECTION_PHASES) {
      await f.client.update(id, { title: `race ${boundary}`, unset: ["parent", "assignee", "sprint", "release", "blocked_by", "blocked_reason"], clearDeps: true });
      let injected = false;
      const outer = await refreshEventProjection({ ...options, rebuild: true, onTransition: async (phase) => {
        if (phase !== boundary) return;
        injected = true;
        const peer = await refreshEventProjection(options);
        if (phase === "beforeLease" || phase === "released") assert.equal(peer.ok, true, JSON.stringify(peer));
        else assert.equal(peer.refusal?.code, "STORAGE_BUSY", `boundary ${phase}: ${JSON.stringify(peer)}`);
      } });
      assert.equal(injected, true, boundary);
      assert.equal(outer.ok, true, JSON.stringify(outer));
      await assertFull(options);
    }
  } finally { rmSync(f.ws, { recursive: true, force: true }); }
});

test("sink crash recovery, target revision conflicts, no-op verification and sparse relationship removal", async () => {
  const f = fixture();
  try {
    const a = await seed(f.client, "sink-a"); const b = await seed(f.client, "sink-b");
    await f.client.update(a, { blockedBy: b });
    let sinkRevision: string | null = null;
    let writes = 0;
    let latest: ProjectionDelta | undefined;
    const sink = { key: "test-transactional-sink", apply: async (delta: ProjectionDelta): Promise<"applied" | "already_applied" | "conflict"> => {
      latest = delta;
      if (sinkRevision === delta.revision) return "already_applied";
      if (sinkRevision !== delta.expected) return "conflict";
      writes++; sinkRevision = delta.revision; return "applied";
    } };
    const options = { pmRoot: f.pmRoot, stateFile: f.stateFile, sink };
    const initial = await refreshEventProjection(options); assert.equal(initial.ok, true, JSON.stringify(initial));
    const before = readFileSync(f.stateFile, "utf8");
    await f.client.update(a, { unset: ["blocked_by", "blocked_reason"] });
    const failed = await refreshEventProjection({ ...options, onTransition: (phase) => { if (phase === "afterSink") throw new Error("interrupted"); } });
    assert.equal(failed.ok, false);
    assert.equal(readFileSync(f.stateFile, "utf8"), before);
    const afterCrash: string | null = latest?.revision ?? null;
    const recovered = await refreshEventProjection(options); assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.revision, afterCrash); assert.equal(writes, 2);
    assert.equal(latest?.removeEdges.filter((edge) => edge.type === "BLOCKED_BY").length, 1);
    assert.equal((await refreshEventProjection(options)).ok, true);
    sinkRevision = "peer-newer-revision";
    assert.equal((await refreshEventProjection(options)).refusal?.code, "SINK_CONFLICT");
    assert.equal((await refreshEventProjection({ pmRoot: f.pmRoot, stateFile: f.stateFile })).refusal?.code, "SINK_CONFLICT");
    await f.client.update(a, { title: "current revision" });
    assert.equal((await refreshEventProjection(options)).refusal?.code, "SINK_CONFLICT");
    assert.equal((await readEventProjection(f.stateFile))?.revision, recovered.revision);
  } finally { rmSync(f.ws, { recursive: true, force: true }); }
});

test("one mutation among 10000 SDK-readable items avoids a full successful source refresh scan", async (t) => {
  const f = fixture();
  try {
    const id = await seed(f.client, "scale-seed");
    const template = await authoritative(f.pmRoot, id);
    // Native setup serialization is SDK-owned. Each generated document is admitted
    // by the real certified reader; only the changed item gets a native mutation.
    for (let i = 1; i < 10000; i++) {
      const item = { ...template, id: `sparse-scale-${i}`, title: `Scale ${i}` };
      writeFileSync(getItemPath(f.pmRoot, "Task", item.id), serializeItemDocument({ metadata: item, body: "" }));
    }
    const options = { pmRoot: f.pmRoot, stateFile: f.stateFile };
    const admitted = await refreshEventProjection(options);
    assert.equal(admitted.ok, true, JSON.stringify(admitted)); assert.equal(admitted.projectedItems, 10000);
    await f.client.update(id, { title: "Changed once", unset: ["parent", "assignee", "sprint", "release", "blocked_by", "blocked_reason"], clearDeps: true });
    const start = performance.now();
    const sparse = await refreshEventProjection(options);
    assert.equal(sparse.ok, true, JSON.stringify(sparse));
    assert.deepEqual({ reads: sparse.itemReads, scans: sparse.fullScans, projected: sparse.projectedItems }, { reads: 1, scans: 0, projected: 1 });
    assert.deepEqual(sparse.eventSources, ["derived_index"]);
    const state = await assertFull(options);
    const rebuilt = await refreshEventProjection({ ...options, rebuild: true });
    assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt));
    assert.deepEqual(comparable((await readEventProjection(f.stateFile))!.graph), comparable(state.graph));
    t.diagnostic(JSON.stringify({ items: 10000, itemReads: sparse.itemReads, fullScans: sparse.fullScans, evaluatedNodes: sparse.evaluatedNodes, evaluatedEdges: sparse.evaluatedEdges, jsonBytes: Buffer.byteLength(JSON.stringify(sparse)), elapsedWithVerificationMs: Math.round(performance.now() - start) }));
  } finally { rmSync(f.ws, { recursive: true, force: true }); }
});

test("source churn, event budgets, missing targets and validation script keep prior checkpoints intact", async () => {
  const f = fixture();
  try {
    const id = await seed(f.client, "guards");
    const options = { pmRoot: f.pmRoot, stateFile: f.stateFile };
    const initial = await refreshEventProjection(options); assert.equal(initial.ok, true, JSON.stringify(initial));
    const before = readFileSync(f.stateFile, "utf8");
    await f.client.update(id, { title: "first update" });
    await f.client.update(id, { title: "second update" });
    assert.equal((await refreshEventProjection({ ...options, maxEvents: 1 })).refusal?.code, "LIMIT");
    assert.equal(readFileSync(f.stateFile, "utf8"), before);
    const raced = await refreshEventProjection({ ...options, onTransition: async (phase) => {
      if (phase === "projected") await f.client.update(id, { title: "competing source mutation" });
    } });
    assert.equal(raced.refusal?.code, "SOURCE_BUSY");
    assert.equal(readFileSync(f.stateFile, "utf8"), before);
    assert.equal((await refreshEventProjection(options)).ok, true);
    const target = getItemPath(f.pmRoot, "Task", id);
    const document = readFileSync(target, "utf8");
    await f.client.update(id, { title: "missing later" }); rmSync(target);
    assert.equal((await refreshEventProjection(options)).refusal?.code, "SOURCE_INCOMPLETE");
    writeFileSync(target, document);
    assert.equal((await refreshEventProjection({ ...options, rebuild: true })).ok, true);
    const invalidParent = join(f.ws, "ordinary-file"); writeFileSync(invalidParent, "foreign");
    assert.equal((await refreshEventProjection({ ...options, stateFile: join(invalidParent, "child.json") })).refusal?.code, "STORAGE_BUSY");
  } finally { rmSync(f.ws, { recursive: true, force: true }); }
});

test("legacy optional dependency fields and random custom status roles survive the producer/validator round trip", async () => {
  const f = fixture();
  try {
    const a = await seed(f.client, "legacy-a"); const b = await seed(f.client, "legacy-b");
    const roles = ["active", "blocked", "terminal_done", "terminal_canceled"];
    const statuses = roles.map((role, index) => `unfamiliar_${Math.imul(index + 17, 731)}_${role.length}`);
    for (let index = 0; index < roles.length; index++) await f.client.schemaAddStatus(statuses[index], { role: [roles[index]] });
    const native = await authoritative(f.pmRoot, a);
    native.dependencies = [{ id: b, kind: "related", created_at: "2026-10-20T00:00:00.000Z" }];
    writeFileSync(getItemPath(f.pmRoot, "Task", a), serializeItemDocument({ metadata: native, body: "" }));
    const options = { pmRoot: f.pmRoot, stateFile: f.stateFile };
    const receipt = await refreshEventProjection(options); assert.equal(receipt.ok, true, JSON.stringify(receipt));
    await assertFull(options);
    for (const status of statuses) {
      await f.client.update(b, { status, closeReason: "custom role proof", force: true, unset: ["parent", "assignee", "sprint", "release", "blocked_by", "blocked_reason"], clearDeps: true });
      const refreshed = await refreshEventProjection(options); assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
      const state = await assertFull(options);
      assert.equal(state.graph.nodes.find((node) => node.id === b)?.properties.status, status);
    }
  } finally { rmSync(f.ws, { recursive: true, force: true }); }
});
