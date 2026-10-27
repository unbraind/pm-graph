/** Strict ownership result guards stop every dependent write and retain real SDK source state. */
import { registerHooks } from "node:module";
import { resolve } from "./fixtures/neo4j-default-loader.ts";
registerHooks({ resolve });
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, seed } from "./event-projection-helpers.ts";
import { applyEnv, collectHandlers, restoreEnv } from "./helpers.ts";
import { fakeRecord, getFakeNeo4jCalls, resetFakeNeo4j, setFakeNeo4jFail, setFakeNeo4jWrite } from "./fixtures/neo4j-fake.ts";
import type { EventProjectionReceipt } from "../src/index.ts";

test("every missing, nonfinite or conflicting Neo4j guard aborts dependent writes before checkpoint publication", async () => {
  const f = fixture();
  const savedEnv = applyEnv({ NEO4J_URI: "bolt://fixture.invalid", NEO4J_USER: "fixture", NEO4J_PASSWORD: "synthetic" });
  try {
    const a = await seed(f.client, "guard-a"); const b = await seed(f.client, "guard-b");
    await f.client.update(a, { blockedBy: b, unset: ["parent", "assignee", "reviewer", "sprint", "release", "blocked_reason"], clearDeps: true });
    const source = (await f.client.listAllComplete({ includeBody: true })).items;
    const run = collectHandlers().get("pm-graph refresh")!;
    const invoke = async (file: string): Promise<EventProjectionReceipt> => await run({ pm_root: f.pmRoot, cwd: f.ws, args: [file, "--neo4j"] }) as EventProjectionReceipt;
    resetFakeNeo4j();
    setFakeNeo4jWrite((query) => ({ records: [fakeRecord(query.includes("RETURN m.revision") ? { revision: null } : { foreign: 0, written: 1 })] }));
    assert.equal((await invoke("baseline.json")).ok, true);
    const guards = getFakeNeo4jCalls().filter((call) => /RETURN foreign|AS written/.test(call.query)).map((call) => call.query);
    assert.ok(guards.length > 3);
    let sequence = 0;
    for (const query of guards) for (const invalid of [undefined, "missing", "undefined-value", null, "0", Infinity, -1]) {
      resetFakeNeo4j();
      let injected = false;
      setFakeNeo4jWrite((text) => {
        if (text === query) {
          injected = true;
          const value = invalid === "undefined-value" ? undefined : invalid;
          return { records: invalid === undefined ? [] : [fakeRecord(invalid === "missing" ? {} : { foreign: value, written: value })] };
        }
        assert.equal(injected, false, "a rejected guard must skip every dependent statement");
        return { records: [fakeRecord(text.includes("RETURN m.revision") ? { revision: null } : { foreign: 0, written: 1 })] };
      });
      const file = `guard-${sequence++}.json`;
      const result = await invoke(file);
      assert.equal(result.refusal?.code, "SINK_CONFLICT", JSON.stringify({ query, invalid, result }));
      assert.equal(existsSync(join(f.ws, file)), false);
      assert.deepEqual((await f.client.listAllComplete({ includeBody: true })).items, source);
    }
  } finally { resetFakeNeo4j(); restoreEnv(savedEnv); rmSync(f.ws, { recursive: true, force: true }); }
});

test("both sync paths disclose concurrency/deletion conflicts and retain unrelated availability errors", async () => {
  const f = fixture();
  const savedEnv = applyEnv({ NEO4J_URI: "bolt://fixture.invalid", NEO4J_USER: "fixture", NEO4J_PASSWORD: "synthetic" });
  try {
    await seed(f.client, "native-errors");
    const handlers = collectHandlers();
    for (const code of ["Neo.ClientError.Schema.ConstraintValidationFailed", "Neo.TransientError.Transaction.DeadlockDetected", "Neo.ClientError.Statement.EntityNotFound", "Neo.ClientError.Statement.TypeError"]) {
      setFakeNeo4jFail(Object.assign(new Error("Synthetic concurrency conflict"), { code }));
      for (const name of ["pm-graph sync", "pm-graph refresh"]) {
        const result = await handlers.get(name)!({ cwd: f.ws, pm_root: f.pmRoot, args: name.endsWith("refresh") ? ["native.json", "--neo4j"] : [] }) as EventProjectionReceipt;
        assert.equal(result.refusal?.code, "SINK_CONFLICT");
      }
    }
    setFakeNeo4jFail("non-error availability failure");
    await assert.rejects(handlers.get("pm-graph sync")!({ cwd: f.ws, pm_root: f.pmRoot }), /Neo4j|non-error/);
    setFakeNeo4jFail(undefined);
    for (const deleted of [undefined, null, "0", Infinity, NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      setFakeNeo4jWrite(() => ({ records: [fakeRecord({ foreign: 0, written: 1, deleted })] }));
      const result = await handlers.get("pm-graph sync")!({ cwd: f.ws, pm_root: f.pmRoot }) as EventProjectionReceipt;
      assert.equal(result.refusal?.code, "SINK_CONFLICT");
    }
  } finally { resetFakeNeo4j(); restoreEnv(savedEnv); rmSync(f.ws, { recursive: true, force: true }); }
});
