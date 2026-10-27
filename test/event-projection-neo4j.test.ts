/** Exercise the real SDK and the driver's transaction/CAS adapter without a hosted service. */
import { registerHooks } from "node:module";
import { resolve as resolveNeo4j } from "./fixtures/neo4j-default-loader.ts";
registerHooks({ resolve: resolveNeo4j });
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { fixture, seed } from "./event-projection-helpers.ts";
import { collectHandlers, applyEnv, restoreEnv } from "./helpers.ts";
import { fakeRecord, getFakeNeo4jCalls, resetFakeNeo4j, setFakeNeo4jWrite, setFakeNeo4jFail, wasFakeNeo4jClosed } from "./fixtures/neo4j-fake.ts";
import type { EventProjectionReceipt } from "../src/index.ts";

test("Neo4j sparse transaction locks before revision read, replaces properties, removes stale edges and reports peer success", async () => {
  const f = fixture();
  const original = applyEnv({ NEO4J_URI: "bolt://fixture.invalid", NEO4J_USER: "fixture", NEO4J_PASSWORD: "synthetic" });
  try {
    const a = await seed(f.client, "neo-a"); const b = await seed(f.client, "neo-b");
    await f.client.update(a, { blockedBy: b });
    resetFakeNeo4j();
    let revision: unknown = null;
    setFakeNeo4jWrite((query, params) => {
      if (query.includes("RETURN m.revision")) return { records: [fakeRecord({ revision })] };
      if (query.includes("SET m.revision")) revision = params?.revision;
      return { records: [] };
    });
    const run = collectHandlers().get("pm-graph refresh")!;
    const invoke = async (): Promise<EventProjectionReceipt> => await run({ cwd: f.ws, pm_root: f.pmRoot, args: ["projection.json", "--neo4j"] }) as EventProjectionReceipt;
    const initial = await invoke(); assert.equal(initial.ok, true, JSON.stringify(initial));
    assert.ok(getFakeNeo4jCalls()[0].query.includes("CREATE CONSTRAINT"));
    assert.ok(getFakeNeo4jCalls()[2].query.includes("SET m.lock = true RETURN m.revision"));
    assert.equal(wasFakeNeo4jClosed(), true);
    await f.client.update(a, { unset: ["blocked_by", "blocked_reason"] });
    const changed = await invoke(); assert.equal(changed.ok, true, JSON.stringify(changed));
    assert.ok(getFakeNeo4jCalls().some((call) => call.query.includes("DELETE r")));
    assert.ok(getFakeNeo4jCalls().some((call) => call.query.includes("SET n = $properties")));
    assert.ok(getFakeNeo4jCalls().some((call) => call.query.includes("SET r = $properties")));
    const noop = await invoke(); assert.equal(noop.ok, true, JSON.stringify(noop));
    await f.client.update(a, { title: "driver retry" });
    let markerReads = 0;
    process.env.PM_GRAPH_TEST_REPEAT_WRITE = "1";
    setFakeNeo4jWrite((query) => query.includes("RETURN m.revision") ? { records: [fakeRecord({ revision: ++markerReads === 1 ? revision : "competing-retry" })] } : { records: [] });
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
