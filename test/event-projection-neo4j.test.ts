/** Exercise the real SDK and the driver's transaction/CAS adapter without a hosted service. */
import { registerHooks } from "node:module";
import { resolve as resolveNeo4j } from "./fixtures/neo4j-default-loader.ts";
registerHooks({ resolve: resolveNeo4j });
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { fixture, seed } from "./event-projection-helpers.ts";
import { collectHandlers, applyEnv, restoreEnv } from "./helpers.ts";
import { fakeRecord, getFakeNeo4jCalls, resetFakeNeo4j, setFakeNeo4jWrite, setFakeNeo4jRead, setFakeNeo4jFail, wasFakeNeo4jClosed } from "./fixtures/neo4j-fake.ts";
import type { EventProjectionReceipt } from "../src/index.ts";

test("Neo4j sparse transaction locks before revision read, replaces properties, removes stale edges and reports peer success", async () => {
  const f = fixture();
  const original = applyEnv({ NEO4J_URI: "bolt://fixture.invalid", NEO4J_USER: "fixture", NEO4J_PASSWORD: "synthetic" });
  try {
    await f.client.schemaAddType("ExternalPmItem");
    const a = await seed(f.client, "neo-a", "ExternalPmItem"); const b = await seed(f.client, "neo-b");
    await f.client.update(a, { blockedBy: b });
    await f.client.update(b, { blockedBy: a });
    resetFakeNeo4j();
    const handlers = collectHandlers();
    const legacy = await handlers.get("pm-graph sync")!({ cwd: f.ws, pm_root: f.pmRoot, args: [] }) as { ok: boolean };
    assert.equal(legacy.ok, true);
    const legacyWrite = getFakeNeo4jCalls().find((call) => call.query.includes("SET n += $properties") && call.params?.id === a);
    assert.deepEqual(legacyWrite?.params?.labels, ["PmItem", "ExternalPmItem"]);
    assert.equal((legacyWrite?.params?.properties as { status: string }).status, "open");
    resetFakeNeo4j();
    let revision: unknown = null;
    let head: unknown;
    setFakeNeo4jRead(() => ({ records: revision === null ? [] : [fakeRecord({ owner: "pm-graph/event-projection", revision, sourceHead: /^[a-f0-9]{64}$/.test(String(revision)) ? head : null })] }));
    setFakeNeo4jWrite((query, params) => {
      if (query.includes("RETURN m.revision")) return { records: [fakeRecord({ revision })] };
      if (query.includes("SET m.revision")) { revision = params?.revision; head = params?.sourceHead; }
      return { records: [fakeRecord({ foreign: 0, written: 1 })] };
    });
    const run = handlers.get("pm-graph refresh")!;
    const invoke = async (): Promise<EventProjectionReceipt> => await run({ cwd: f.ws, pm_root: f.pmRoot, args: ["projection.json", "--neo4j"] }) as EventProjectionReceipt;
    const initial = await invoke(); assert.equal(initial.ok, true, JSON.stringify(initial));
    assert.equal(getFakeNeo4jCalls()[0].mode, "read", "inspect the authority before planning writes");
    assert.ok(getFakeNeo4jCalls()[1].query.includes("CREATE CONSTRAINT"));
    assert.ok(getFakeNeo4jCalls()[3].query.includes("SET m.lock = true RETURN m.revision"));
    assert.ok(getFakeNeo4jCalls().some((call) => call.query.includes("SET m.revision") && call.query.includes("m.sourceHead = $sourceHead")));
    const authoritativeWrite = getFakeNeo4jCalls().find((call) => call.query.includes("SET n = $properties") && call.params?.id === a);
    assert.deepEqual(authoritativeWrite?.params?.labels, ["PmItem", "ExternalPmItem"]);
    assert.equal((authoritativeWrite?.params?.properties as { status: string }).status, "open");
    assert.equal(wasFakeNeo4jClosed(), true);
    await f.client.update(a, { unset: ["blocked_by", "blocked_reason"] });
    const changed = await invoke(); assert.equal(changed.ok, true, JSON.stringify(changed));
    assert.ok(getFakeNeo4jCalls().some((call) => call.query.includes("DELETE r")));
    assert.ok(getFakeNeo4jCalls().some((call) => call.query.includes("SET n = $properties")));
    assert.ok(getFakeNeo4jCalls().some((call) => call.query.includes("SET r = $properties")));
    assert.ok(getFakeNeo4jCalls().every((call) => !call.query.includes("DETACH DELETE")), "all sink paths preserve relationships they do not own");
    const noop = await invoke(); assert.equal(noop.ok, true, JSON.stringify(noop));
    const rebuilt = await run({ cwd: f.ws, pm_root: f.pmRoot, args: ["projection.json", "--neo4j", "--rebuild"] }) as EventProjectionReceipt;
    assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt)); assert.equal(rebuilt.fullScans, 1);
    assert.ok(getFakeNeo4jCalls().some((call) => call.query.includes("WHERE NOT n.id IN $currentIds")), "rebuild deletes only stale owned nodes");
    await f.client.update(a, { title: "driver retry" });
    let markerReads = 0;
    process.env.PM_GRAPH_TEST_REPEAT_WRITE = "1";
    setFakeNeo4jWrite((query) => query.includes("RETURN m.revision") ? { records: [fakeRecord({ revision: ++markerReads === 1 ? revision : "competing-retry" })] } : { records: [fakeRecord({ foreign: 0, written: 1 })] });
    assert.equal((await invoke()).refusal?.code, "SINK_CONFLICT");
    delete process.env.PM_GRAPH_TEST_REPEAT_WRITE;
    await f.client.update(a, { title: "foreign collision" });
    setFakeNeo4jWrite((query) => query.includes("RETURN m.revision") ? { records: [fakeRecord({ revision })] } : { records: [fakeRecord({ foreign: 1 })] });
    assert.equal((await invoke()).refusal?.code, "SINK_CONFLICT");
    setFakeNeo4jWrite(() => ({ records: [] }));
    assert.equal((await invoke()).refusal?.code, "SINK_CONFLICT");
    setFakeNeo4jWrite((query) => query.includes("RETURN m.revision") ? { records: [fakeRecord({ revision: "peer" })] } : { records: [] });
    revision = "peer";
    assert.equal((await invoke()).refusal?.code, "SINK_CONFLICT");
    setFakeNeo4jFail(new Error("synthetic driver failure"));
    assert.equal((await invoke()).ok, false);
    assert.equal(wasFakeNeo4jClosed(), true);
  } finally { resetFakeNeo4j(); restoreEnv(original); rmSync(f.ws, { recursive: true, force: true }); }
});
