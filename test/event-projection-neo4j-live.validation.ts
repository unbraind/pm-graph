/** Real two-session interleavings against an explicitly supplied isolated Neo4j distribution. */
import { registerHooks } from "node:module";
import { spawn } from "node:child_process";
import { resolve } from "./fixtures/neo4j-live-loader.ts";
registerHooks({ resolve });
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve as absolute } from "node:path";
import neo4j from "neo4j-driver";
import { deleteItem } from "@unbrained/pm-cli/sdk";
import { publicChildEnv } from "./fixtures/public-child-env.ts";
import { startNeo4j } from "./fixtures/neo4j-server.ts";
import { observeLiveQueries, runLiveObserved } from "./fixtures/neo4j-live-proxy.ts";
import { fixture, seed } from "./event-projection-helpers.ts";
import { applyEnv, collectHandlers, restoreEnv } from "./helpers.ts";
import type { OwnedStatement } from "../src/neo4j-ownership.ts";
import { createNeo4jProjectionSink, readEventProjection, refreshEventProjection } from "../src/index.ts";
import type { EventProjectionReceipt } from "../src/index.ts";

const home = process.argv[2];
assert.ok(home, "Supply an unpacked isolated Neo4j fixture distribution");
const variant = process.argv[3];
assert.ok(process.argv.length <= 4 && (variant === undefined || ["--sparse-only", "--preservation-only", "--packed-only", "--collision-only", "--edges-only", "--recovery-only", "--rebuild-only"].includes(variant)), "Use only a fixture home and an optional focused variant");
const server = await startNeo4j(absolute(home));
console.log(JSON.stringify({ fixtureReady: true, maxProcessors: 2, maxHeapMiB: 512 }));
const actual = neo4j.driver(server.uri, neo4j.auth.basic("fixture", "synthetic"), { maxTransactionRetryTime: 0 });
const originalEnv = applyEnv({ NEO4J_URI: server.uri, NEO4J_USER: "fixture", NEO4J_PASSWORD: "synthetic", NEO4J_DATABASE: "neo4j", NEO4J_MAX_RETRY_MS: "0" });
const f = fixture();
const handlers = collectHandlers();
const a = await seed(f.client, "victim");
const b = await seed(f.client, "retained");
await f.client.update(a, { blockedBy: b, unset: ["parent", "assignee", "reviewer", "sprint", "release", "blocked_reason"], clearDeps: true });
let cases = 0;
let blocked = 0;
let nextToken = 0;
let closingRollbacks = 0;
const query = async (text: string, params: Record<string, unknown> = {}) => {
  const session = actual.session();
  try { return await session.run(text, params); } finally { await session.close(); }
};

/** Execute the actual producer's guarded plan in one transaction, as required by its receipt. */
async function executePlan(): Promise<EventProjectionReceipt> {
  const result = await handlers.get("pm-graph cypher")!({ pm_root: f.pmRoot, cwd: f.ws }) as { prerequisites: { statement: string }[]; statements: OwnedStatement[] };
  const session = actual.session();
  try {
    for (const step of result.prerequisites) await session.run(step.statement);
    await session.executeWrite(async (tx) => {
      for (const step of result.statements) {
        const response = await runLiveObserved(tx, step.statement, step.parameters);
        assert.equal(response.records.length, 1);
        if (Number(response.records[0].get(step.expect.key)) !== step.expect.value)
          throw Object.assign(new Error("Owned plan refused"), { code: "Neo.ClientError.Schema.ConstraintValidationFailed" });
      }
    });
    return { ok: true, work: [] };
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && String(error.code).startsWith("Neo.ClientError."))
      return { ok: false, refusal: { code: "SINK_CONFLICT", remedy: "Reconcile current sink ownership" }, work: [] };
    throw error;
  } finally { await session.close(); }
}

/** Identify projection commands independently of their refresh strategy. */
function projectionMode(mode: string): boolean { return mode === "sparse" || mode === "sparse-rebuild"; }

/** Both sparse and legacy paths use the normal command host over the same non-git tracker. */
async function invoke(mode: string): Promise<EventProjectionReceipt> {
  if (mode === "cypher") return executePlan();
  const handler = handlers.get(projectionMode(mode) ? "pm-graph refresh" : "pm-graph sync")!;
  return await handler({ pm_root: f.pmRoot, cwd: f.ws, args: projectionMode(mode) ? ["projection.json", "--neo4j", ...(mode === "sparse-rebuild" ? ["--rebuild"] : [])] : mode === "full" ? ["--full"] : [] }) as EventProjectionReceipt;
}

/** Late node collisions and preexisting same-kind foreign edges exercise the shared MERGE guards. */
async function collisionCases(): Promise<void> {
  observeLiveQueries(undefined);
  const identityFile = join(f.ws, "identity.json");
  assert.equal((await refreshEventProjection({ pmRoot: f.pmRoot, stateFile: identityFile })).ok, true);
  const identity = await readEventProjection(identityFile); assert.ok(identity);
  const exported = await handlers.get("pm-graph cypher")!({ pm_root: f.pmRoot, cwd: f.ws }) as { statements: OwnedStatement[] };
  const legacyKey = String(exported.statements[0].parameters.projectKey);
  for (const mode of ["sparse", "sparse-rebuild", "legacy", "full", "cypher"]) {
    await query("MATCH (n) DETACH DELETE n");
    await f.client.restore(a, "2"); rmSync(f.stateFile, { force: true });
    await query("CREATE (:FixtureForeign {id:'peer'})");
    const label = projectionMode(mode) ? "PmGraphProjectionNode" : "PmGraphNode";
    const key = projectionMode(mode) ? identity.source : legacyKey;
    let injected = false;
    observeLiveQueries(async (phase, text, parameters) => {
      if (injected || phase !== "before" || !text.startsWith(`MERGE (n:${label}`) || parameters?.id !== a) return;
      injected = true;
      await query(`MATCH (p:FixtureForeign {id:'peer'}) CREATE (n:${label} {projectKey:$key,id:$id,pmGraphOwner:'peer',title:'foreign original',__pmLock:false}) CREATE (n)-[:FOREIGN {pmGraphOwner:'peer'}]->(p)`, { key, id: a });
    });
    const result = await invoke(mode); observeLiveQueries(undefined);
    assert.ok(injected, `${mode}: late node collision injected`);
    assert.equal(result.refusal?.code, "SINK_CONFLICT", `${mode}: late foreign node must refuse`);
    const node = await query(`MATCH (n:${label} {projectKey:$key,id:$id}) RETURN n.pmGraphOwner AS owner,n.title AS title,n.__pmLock AS lock`, { key, id: a });
    assert.equal(node.records[0].get("owner"), "peer"); assert.equal(node.records[0].get("title"), "foreign original");
    assert.equal(node.records[0].get("lock"), false);
    if (projectionMode(mode)) assert.equal(existsSync(f.stateFile), false);
  }
  await query("MATCH (n) DETACH DELETE n");
  await f.client.restore(a, "1"); rmSync(f.stateFile, { force: true });
  assert.equal((await invoke("sparse")).ok, true);
  const before = readFileSync(f.stateFile, "utf8");
  await query("MATCH (a:PmGraphProjectionNode {projectKey:$key,id:$from}),(b:PmGraphProjectionNode {projectKey:$key,id:$to}) CREATE (a)-[:BLOCKED_BY {pmGraphOwner:'peer',source:'foreign original',__pmLock:false}]->(b)", { key: identity.source, from: a, to: b });
  await f.client.update(a, { blockedBy: b, unset: ["parent", "assignee", "reviewer", "sprint", "release", "blocked_reason"], clearDeps: true });
  const result = await invoke("sparse");
  assert.equal(result.refusal?.code, "SINK_CONFLICT", "a matching foreign relationship must never be overwritten");
  assert.equal(readFileSync(f.stateFile, "utf8"), before);
  const edge = await query("MATCH (:PmGraphProjectionNode {projectKey:$key,id:$from})-[r:BLOCKED_BY]->(:PmGraphProjectionNode {projectKey:$key,id:$to}) RETURN r.pmGraphOwner AS owner,r.source AS source,r.__pmLock AS lock", { key: identity.source, from: a, to: b });
  assert.equal(edge.records[0].get("owner"), "peer"); assert.equal(edge.records[0].get("source"), "foreign original");
  assert.equal(edge.records[0].get("lock"), false);
  console.log(JSON.stringify({ lateNodeCollisions: 4, foreignRelationshipCollisions: 1, preserved: true }));
}

/** Compare native SDK state with a fresh full reference written through the exact same sink producer. */
async function recoveryCases(): Promise<void> {
  observeLiveQueries(undefined);
  const sink = createNeo4jProjectionSink();
  const reference = { key: "native-full-reference", inspect: async () => sink.inspect!("native-full-reference"), apply: async (delta: Parameters<typeof sink.apply>[0]) => sink.apply({ ...delta, projectKey: "native-full-reference" }) };
  const referenceFile = join(f.ws, "reference.json");
  let recoveredCases = 0;
  for (const phase of ["afterSink", "checkpoint", "receipt"] as const) for (const updates of [0, 1, 2, 3]) for (const rebuild of [false, true]) {
    await query("MATCH (n) DETACH DELETE n");
    rmSync(f.stateFile, { force: true }); rmSync(f.stateFile + ".pending.json", { force: true });
    rmSync(referenceFile, { force: true }); rmSync(referenceFile + ".pending.json", { force: true });
    await f.client.restore(a, "2");
    const options = { pmRoot: f.pmRoot, stateFile: f.stateFile, sink };
    assert.equal((await refreshEventProjection(options)).ok, true);
    const initial = await readEventProjection(f.stateFile); assert.ok(initial);
    await query("MATCH (n:PmGraphProjectionNode {projectKey:$key,id:$id}) CREATE (p:FixtureRecoveryForeign {token:'retain'}) CREATE (n)-[:RECOVERY_PEER {pmGraphOwner:'peer'}]->(p)", { key: initial.source, id: b });
    await f.client.update(a, { title: `committed ${phase} ${updates} ${rebuild}`, unset: ["parent", "assignee", "reviewer", "sprint", "release", "blocked_by", "blocked_reason"], clearDeps: true });
    let interrupted = false;
    const crash = await refreshEventProjection({ ...options, onTransition: (step) => { if (phase === step) { interrupted = true; throw new Error("native post-action crash"); } } });
    assert.equal(interrupted, true); assert.equal(crash.ok, false);
    for (let update = 0; update < updates; update++) await f.client.update(a, { title: `current ${phase} ${updates} ${rebuild} ${update}`, blockedBy: b, unset: ["parent", "assignee", "reviewer", "sprint", "release", "blocked_reason"], clearDeps: true });
    const result = await refreshEventProjection({ ...options, rebuild });
    assert.equal(result.ok, true, JSON.stringify({ phase, updates, rebuild, result }));
    assert.equal(result.fullScans, rebuild ? 1 : 0);
    const state = await readEventProjection(f.stateFile); assert.ok(state);
    const marker = await sink.inspect!(state.source);
    assert.ok(marker && marker !== "conflict");
    assert.equal(marker.revision, state.revision);
    assert.deepEqual(marker.sourceHead, { cursor: state.cursor, anchor: state.anchor });
    assert.equal((await refreshEventProjection({ pmRoot: f.pmRoot, stateFile: referenceFile, sink: reference, rebuild: true })).ok, true);
    // Both reads use native database values after the same SDK write normalization;
    // only target namespace/ownership metadata is outside graph semantics.
    const native = async (key: string): Promise<unknown> => {
      const nodes = await query("MATCH (n:PmGraphProjectionNode {projectKey:$key}) CALL { WITH n UNWIND keys(n) AS k WITH n,k WHERE NOT k IN ['projectKey','pmGraphOwner'] ORDER BY k RETURN collect([k,n[k]]) AS properties } RETURN n.id AS id,properties ORDER BY id", { key });
      const edges = await query("MATCH (a:PmGraphProjectionNode {projectKey:$key})-[r]->(b:PmGraphProjectionNode {projectKey:$key}) WHERE r.pmGraphOwner='pm-graph/event-projection' CALL { WITH r UNWIND keys(r) AS k WITH r,k WHERE k <> 'pmGraphOwner' ORDER BY k RETURN collect([k,r[k]]) AS properties } RETURN a.id AS source,b.id AS target,type(r) AS type,properties ORDER BY source,target,type", { key });
      return { nodes: nodes.records.map((row) => row.toObject()), edges: edges.records.map((row) => row.toObject()) };
    };
    assert.deepEqual(await native(state.source), await native("native-full-reference"));
    const foreign = await query("MATCH ()-[r:RECOVERY_PEER]->(p:FixtureRecoveryForeign) RETURN p.token AS token,r.pmGraphOwner AS owner");
    assert.equal(foreign.records.length, 1); assert.equal(foreign.records[0].get("token"), "retain"); assert.equal(foreign.records[0].get("owner"), "peer");
    recoveredCases++;
    if (recoveredCases % 4 === 0) console.log(JSON.stringify({ nativeRecoveryCases: recoveredCases }));
  }
  console.log(JSON.stringify({ nativeRecoveryCases: recoveredCases, sourceUpdates: "0-3", fullReferenceEqual: true, foreignDataPreserved: true }));
}

try {
  for (const probeNode of variant === "--edges-only" ? [false] : variant && variant !== "--rebuild-only" ? [true] : [true, false])
  for (const mode of variant === "--packed-only" || variant === "--collision-only" || variant === "--recovery-only" ? [] : variant === "--rebuild-only" ? ["sparse-rebuild"] : variant && variant !== "--edges-only" ? ["sparse"] : ["sparse", "sparse-rebuild", "legacy", "full", "cypher"]) for (const dense of variant && variant !== "--edges-only" && variant !== "--rebuild-only" ? [false] : [false, true]) {
    console.log(JSON.stringify({ mode, dense, probeNode, preparing: true }));
    const label = projectionMode(mode) ? "PmGraphProjectionNode" : "PmGraphNode";
    const baseline: string[] = [];
    const prepare = async (): Promise<void> => {
      observeLiveQueries(undefined);
      // The database was created by this fixture; it contains no outside records.
      await query("MATCH (n) DETACH DELETE n");
      await f.client.restore(a, "2");
      rmSync(f.stateFile, { force: true });
      assert.equal((await invoke(mode)).ok, true);
      if (dense) {
        await query(`MATCH (n:${label} {id: $id}) UNWIND range(1,65) AS i CREATE (p:FixtureDensity {i:i}) CREATE (n)-[:DENSITY]->(p)`, { id: a });
        await query("MATCH (p:FixtureDensity) DETACH DELETE p");
      }
      await query("CREATE (:FixtureForeign {id: 'peer'})");
      await deleteItem(a, { force: true }, { pmRoot: f.pmRoot, noExtensions: true, author: "graph-test" });
    };
    await prepare();
    observeLiveQueries(async (phase, text) => { if (phase === "before") baseline.push(text); });
    assert.equal((await invoke(mode)).ok, true);
    observeLiveQueries(undefined);
    for (let boundary = 0; boundary < baseline.length * 2; boundary++) {
      await prepare();
      const checkpoint = existsSync(f.stateFile) ? readFileSync(f.stateFile, "utf8") : undefined;
      let step = 0;
      let injected = false;
      let missingRequiredLock = false;
      let injection = "";
      let lastStatuses: string[] = [];
      let peer: Promise<number> | undefined;
      const token = `peer-${++nextToken}`;
      observeLiveQueries(async (phase, text) => {
        if (step++ !== boundary) return;
        injected = true;
        injection = `${phase} ${text.slice(0, 100)}`;
        let settled = false;
        let queryCompleted = false;
        const session = actual.session();
        peer = (async () => {
          const tx = session.beginTransaction({ metadata: { fixtureToken: token } });
          try {
            // The optional node probe proves NODE write exclusion independently
            // of commit-stage locks; pure-edge runs omit that extra write.
            const result = await tx.run(`MATCH (n:${label} {id: $id}), (p:FixtureForeign {id:'peer'})
${probeNode ? "SET n.__peerProbe = $token" : ""}
CREATE (n)-[r:FOREIGN {pmGraphOwner:'peer', token:$token}]->(p) RETURN count(r) AS created`, { id: a, token });
            queryCompleted = true;
            await tx.commit(); return Number(result.records[0].get("created"));
          } catch (error) { await tx.rollback(); throw error; }
          finally { settled = true; await session.close(); }
        })();
        void peer.catch(() => {}); // The assertion below awaits and reports peer failures after rollback.
        // Observe the real server's lock wait, rather than assuming a scheduled promise ran.
        for (let attempt = 0; attempt < 150; attempt++) {
          if (settled) break;
          const transactions = await query("SHOW TRANSACTIONS YIELD metaData, status WHERE metaData.fixtureToken = $token RETURN status", { token });
          lastStatuses = transactions.records.map((record) => String(record.get("status")));
          if (transactions.records.some((record) => String(record.get("status")).startsWith("Blocked"))) {
            blocked++;
            throw Object.assign(new Error("Fixture requests rollback while peer waits"), { code: "Neo.ClientError.Schema.ConstraintValidationFailed" });
          }
          if (!probeNode && queryCompleted && attempt >= 10 && lastStatuses.includes("Closing")) {
            // Dense relationship creation may wait only during commit. The query
            // has already created its real edge; roll back the contender to let
            // that peer finish, without claiming a NODE write-lock observation.
            closingRollbacks++;
            throw Object.assign(new Error("Fixture requests rollback during peer commit"), { code: "Neo.ClientError.Schema.ConstraintValidationFailed" });
          }
          await new Promise((resolve) => { setTimeout(resolve, 10); });
        }
        assert.equal(settled, true, "peer must commit or demonstrably wait on the transaction lock");
        if (probeNode && variant !== "--preservation-only" && projectionMode(mode) && !dense && phase === "after" && text.includes("WITH collect(n) AS ns") && text.endsWith("RETURN foreign")) {
          missingRequiredLock = true;
          assert.fail("the ownership check must hold the sparse victim's write lock until commit");
        }
      });
      const result = await invoke(mode);
      observeLiveQueries(undefined);
      assert.equal(missingRequiredLock, false, "ownership read did not retain the sparse-node write lock");
      assert.ok(injected, `${mode} dense=${dense} boundary=${boundary}`);
      const created = await peer;
      assert.equal(created, 1, "fixture peer must create an actual foreign edge");
      const remaining = await query("MATCH ()-[r:FOREIGN {token:$token}]->() RETURN count(r) AS count", { token });
      assert.equal(Number(remaining.records[0].get("count")), 1, `${mode} dense=${dense} boundary=${boundary}: foreign edge was lost`);
      if (probeNode) {
        const probe = await query(`MATCH (n:${label} {id:$id}) RETURN n.__peerProbe AS token`, { id: a });
        assert.equal(probe.records[0].get("token"), token);
      }
      assert.equal(result.ok, false, `${mode} boundary ${boundary} must refuse the competing write`);
      assert.equal(result.refusal?.code, "SINK_CONFLICT", JSON.stringify({ mode, dense, boundary, injection, lastStatuses, result }));
      if (checkpoint !== undefined) assert.equal(readFileSync(f.stateFile, "utf8"), checkpoint);
      cases++;
      if (cases % 8 === 0) console.log(JSON.stringify({ passedTransitions: cases, blockedPeerTransitions: blocked }));
    }
    console.log(JSON.stringify({ mode, dense, probeNode, boundaries: baseline.length * 2, foreignEdgesPreserved: true }));
  }
  console.log(JSON.stringify({ cases, blockedPeerTransitions: blocked, peerClosingRollbacks: closingRollbacks, realNeo4j: true, nonGitTracker: true }));
  if (variant === undefined || variant === "--collision-only") await collisionCases();
  if (variant === undefined || variant === "--recovery-only") await recoveryCases();
  if (variant === undefined || variant === "--packed-only") {
    const packed = spawn(process.execPath, [join(import.meta.dirname, "event-projection-packed.validation.ts"), server.uri], { cwd: process.cwd(), stdio: "inherit", env: { ...publicChildEnv(), NPM_CONFIG_USERCONFIG: "/dev/null" } });
    const status = await new Promise<number | null>((resolve, reject) => { packed.once("error", reject); packed.once("exit", resolve); });
    assert.equal(status, 0, "all six packed hosts must preserve real Neo4j foreign records");
  }
} finally {
  observeLiveQueries(undefined);
  restoreEnv(originalEnv);
  await actual.close();
  await server.stop();
  rmSync(f.ws, { recursive: true, force: true });
}
