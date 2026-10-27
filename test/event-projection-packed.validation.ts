/** Manual packed acceptance across actual global, ephemeral and project package-manager hosts. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import neo4j from "neo4j-driver";
import { FOREIGN_CHECKPOINTS, clearProjectionHistory } from "./event-projection-recovery-corpus.ts";

const fixtureUri = process.argv[2];
assert.ok(process.argv.length <= 3 && (fixtureUri === undefined || /^bolt:\/\/127\.0\.0\.1:\d+$/.test(fixtureUri)), "Supply only an explicit isolated loopback fixture URI");
const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "graph-packed-"));
const sdkVersion = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { devDependencies: { "@unbrained/pm-cli": string } }).devDependencies["@unbrained/pm-cli"];
assert.match(sdkVersion, /^\d{4}\.\d{1,2}\.\d{1,2}$/);
const baseEnv = { ...process.env, NPM_CONFIG_USERCONFIG: "/dev/null", npm_config_userconfig: "/dev/null", PM_PATH: "", GIT_CEILING_DIRECTORIES: tmpdir() };
/** Run actual package managers and host executables, preserving bounded failure diagnostics. */
function run(bin: string, args: string[], cwd: string, extra: Record<string, string> = {}, expected = 0): string {
  const result = spawnSync(bin, args, { cwd, env: { ...baseEnv, ...extra }, encoding: "utf8", timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, expected, `${bin} ${args[0]}: ${result.stderr || result.stdout || result.error}`);
  return result.stdout;
}
/** Exercise admission and sparse update through a real installed pm host and packed extension. */
async function acceptance(name: string, bin: string, prefix: string[], extension: string, extra: Record<string, string> = {}): Promise<void> {
  const ws = join(scratch, name); mkdirSync(ws);
  const output = (args: string[], expected = 0, json = true): string => run(bin, [...prefix, ...args, ...(json ? ["--json"] : [])], ws, extra, expected);
  const invoke = (args: string[], expected = 0): Record<string, unknown> => JSON.parse(output(args, expected)) as Record<string, unknown>;
  invoke(["init", "--defaults", "--agent-guidance", "skip", "--prefix", "packed"]);
  const extensions = join(ws, ".agents/pm/extensions"); mkdirSync(extensions, { recursive: true });
  const installed = join(extensions, "pm-graph");
  cpSync(extension, installed, { recursive: true });
  const scope = join(installed, "node_modules/@unbrained"); mkdirSync(scope, { recursive: true });
  if (!existsSync(join(scope, "pm-cli"))) symlinkSync(join(dirname(extension), "@unbrained/pm-cli"), join(scope, "pm-cli"), "dir");
  const driverModule = join(installed, "node_modules/neo4j-driver");
  if (!existsSync(driverModule)) symlinkSync(dirname(createRequire(join(extension, "package.json")).resolve("neo4j-driver/package.json")), driverModule, "dir");
  invoke(["schema", "add-type", "ExternalPmItem"]);
  const created = invoke(["create", "ExternalPmItem", "Packed source", "--id", "a", "--create-mode", "progressive", "--unset", "parent", "--unset", "assignee", "--unset", "reviewer", "--unset", "sprint", "--unset", "release", "--unset", "blocked_by", "--unset", "blocked_reason", "--clear-deps"]);
  const id = String(created.id ?? (created.item as { id: string })?.id);
  const referencing = invoke(["create", "Task", "Packed reference", "--id", "b", "--create-mode", "progressive", "--parent", id, "--blocked-by", id, "--dep", `id=${id},kind=related_to`, "--unset", "assignee", "--unset", "reviewer", "--unset", "sprint", "--unset", "release", "--unset", "blocked_reason"]);
  const referenceId = String(referencing.id ?? (referencing.item as { id: string })?.id);
  const initial = invoke(["pm-graph", "refresh", "projection.json"]);
  assert.equal(initial.fullScans, 1);
  invoke(["update", id, "--title", "Packed update", "--unset", "parent", "--unset", "assignee", "--unset", "reviewer", "--unset", "sprint", "--unset", "release", "--unset", "blocked_by", "--unset", "blocked_reason", "--clear-deps"]);
  const sparse = invoke(["pm-graph", "refresh", "projection.json"]);
  assert.equal(sparse.itemReads, 1); assert.equal(sparse.fullScans, 0);
  const graph = JSON.parse(readFileSync(join(ws, "projection.json"), "utf8")) as { graph: { nodes: { id: string; labels: string[]; properties: { title: string; type: string } }[] } };
  const authoritative = graph.graph.nodes.find((node) => node.id === id);
  assert.deepEqual(authoritative?.labels, ["PmItem", "ExternalPmItem"]);
  assert.equal(authoritative.properties.title, "Packed update");
  for (const json of [true, false]) {
    const contracted = output(["pm-graph", "contract", id, referenceId, "--edges", "CHILD_OF,BLOCKED_BY,RELATED_TO"], 0, json);
    if (json) assert.equal(JSON.parse(contracted).receipt.unknown, 0); else assert.match(contracted, /unknown: 0/);
  }
  if (fixtureUri !== undefined) {
    const db = neo4j.driver(fixtureUri, neo4j.auth.basic("fixture", "synthetic"), { maxTransactionRetryTime: 0 });
    const session = db.session();
    const sinkOutput = (flags: string[], json: boolean, expected = 0): string => run(bin, [...prefix, "pm-graph", "refresh", "neo.json", "--neo4j", ...flags, ...(json ? ["--json"] : [])], ws,
      { ...extra, NEO4J_URI: fixtureUri, NEO4J_USER: "fixture", NEO4J_PASSWORD: "synthetic", NEO4J_DATABASE: "neo4j", NEO4J_MAX_RETRY_MS: "0" }, expected);
    try {
      assert.equal(JSON.parse(sinkOutput([], true)).ok, true);
      const checkpoint = readFileSync(join(ws, "neo.json"), "utf8");
      const state = JSON.parse(checkpoint) as { source: string; revision: string };
      await session.run("MATCH (n:PmGraphProjectionNode {projectKey:$key,id:$id}) CREATE (p:PackedForeign {fixtureScope:$key}) CREATE (n)-[:FOREIGN {pmGraphOwner:'peer'}]->(p)", { key: state.source, id });
      invoke(["update", referenceId, "--title", "Packed guarded retry", "--unset", "parent", "--unset", "assignee", "--unset", "reviewer", "--unset", "sprint", "--unset", "release", "--unset", "blocked_by", "--unset", "blocked_reason", "--clear-deps"]);
      invoke(["delete", id, "--force"]);
      for (const lockValue of [null, "must-survive"]) {
        await session.run("MATCH ()-[r:FOREIGN]->(:PackedForeign {fixtureScope:$key}) SET r.__pmLock=$lockValue", { key: state.source, lockValue });
        for (const json of [true, false]) for (const flags of [[], ["--rebuild"]]) {
          const output = sinkOutput(flags, json, 2);
          if (json) assert.equal(JSON.parse(output).refusal.code, "SINK_CONFLICT"); else assert.match(output, /SINK_CONFLICT/);
          assert.equal(readFileSync(join(ws, "neo.json"), "utf8"), checkpoint);
          const foreign = await session.run("MATCH ()-[r:FOREIGN]->(:PackedForeign {fixtureScope:$key}) RETURN r.__pmLock AS value", { key: state.source });
          assert.equal(foreign.records.length, 1); assert.equal(foreign.records[0].get("value"), lockValue);
        }
      }
      await session.run("MATCH ()-[r:FOREIGN]->(p:PackedForeign {fixtureScope:$key}) DELETE r,p", { key: state.source });
      const retry = JSON.parse(sinkOutput([], true));
      assert.equal(retry.ok, true); assert.equal(retry.itemReads, 2); assert.equal(retry.fullScans, 0);
      const native = await session.run("MATCH (n:PmGraphProjectionNode {projectKey:$key,id:$id}) RETURN n.title AS title, n.type AS type", { key: state.source, id: referenceId });
      assert.equal(native.records[0].get("title"), "Packed guarded retry"); assert.equal(native.records[0].get("type"), "Task");
      console.log(JSON.stringify({ host: name, neo4jForeignRefusals: 8, checkpointUnchanged: true, sparseRetryReads: 2, actualNeo4j: true }));
    } finally { await session.close(); await db.close(); }
    return;
  }
  const foreign = join(ws, "foreign.json");
  for (const bytes of FOREIGN_CHECKPOINTS) {
    writeFileSync(foreign, bytes);
    const refusal = invoke(["pm-graph", "refresh", "foreign.json"], 2);
    assert.equal((refusal.refusal as { code: string }).code, "FOREIGN_STATE");
    assert.equal(readFileSync(foreign, "utf8"), bytes);
  }
  writeFileSync(foreign, "null");
  assert.equal((invoke(["pm-graph", "refresh", "foreign.json", "--rebuild"], 2).refusal as { code: string }).code, "FOREIGN_STATE");
  assert.match(output(["pm-graph", "refresh", "foreign.json", "--rebuild"], 2, false), /FOREIGN_STATE/);
  assert.equal(readFileSync(foreign, "utf8"), "null");
  for (const json of [true, false]) {
    invoke(["update", id, "--title", `Next generation ${json}`, "--unset", "parent", "--unset", "assignee", "--unset", "reviewer", "--unset", "sprint", "--unset", "release", "--unset", "blocked_by", "--unset", "blocked_reason", "--clear-deps"]);
    invoke(["pm-graph", "refresh", "projection.json"]);
    clearProjectionHistory(join(ws, ".agents/pm"));
    const rebuilt = output(["pm-graph", "refresh", "projection.json", "--rebuild"], 0, json);
    if (json) assert.equal(JSON.parse(rebuilt).mode, "rebuild"); else assert.match(rebuilt, /mode: "?rebuild"?/);
    const state = JSON.parse(readFileSync(join(ws, "projection.json"), "utf8")) as Record<string, unknown>;
    assert.equal(Object.hasOwn(state, "cursor"), false); assert.equal(Object.hasOwn(state, "anchor"), false);
    assert.deepEqual(state.versions, {});
    assert.equal(invoke(["pm-graph", "refresh", "projection.json"]).fullScans, 0);
  }
  console.log(JSON.stringify({ host: name, admission: true, sparseReads: 1, fullScans: 0, authoritativeTypeCollision: true, contractionFormats: 2, foreignPayloads: FOREIGN_CHECKPOINTS.length, rebuildFormats: 2 }));
}
try {
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", scratch], root);
  const archive = join(scratch, readdirSync(scratch).find((file) => file.endsWith(".tgz"))!);
  const npmPrefix = join(scratch, "npm-global-prefix");
  run("npm", ["install", "--global", "--prefix", npmPrefix, "--ignore-scripts", archive, `@unbrained/pm-cli@${sdkVersion}`], scratch);
  const npmExtension = join(npmPrefix, "lib/node_modules/pm-graph");
  await acceptance("npm-global", join(npmPrefix, "bin/pm"), [], npmExtension);
  const bunRoot = join(scratch, "bun-global-root"); const bunBin = join(scratch, "bun-global-bin");
  const bunEnv = { BUN_INSTALL_GLOBAL_DIR: bunRoot, BUN_INSTALL_BIN: bunBin };
  run("bun", ["add", "--global", "--ignore-scripts", archive, `@unbrained/pm-cli@${sdkVersion}`], scratch, bunEnv);
  await acceptance("bun-global", join(bunBin, "pm"), [], join(bunRoot, "node_modules/pm-graph"), bunEnv);
  await acceptance("npx", "npx", ["--yes", "--package", `@unbrained/pm-cli@${sdkVersion}`, "pm"], npmExtension);
  await acceptance("bunx", "bunx", ["--package", `@unbrained/pm-cli@${sdkVersion}`, "pm"], npmExtension);
  for (const manager of ["npm", "bun"]) {
    const project = join(scratch, `${manager}-project`); mkdirSync(project);
    writeFileSync(join(project, "package.json"), '{"name":"packed-acceptance","private":true}');
    run(manager, [manager === "npm" ? "install" : "add", "--ignore-scripts", archive, `@unbrained/pm-cli@${sdkVersion}`], project);
    await acceptance(`${manager}-local`, join(project, "node_modules/.bin/pm"), [], join(project, "node_modules/pm-graph"));
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
