import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PmClient, listAllComplete } from "@unbrained/pm-cli/sdk";
import type { PmCompleteListResult } from "@unbrained/pm-cli/sdk";
import { projectWorkspaces, qualifyProjectionId } from "../src/index.ts";
import type { ProjectionEvidence, ProjectionOptions, ProjectionResult, ProjectionScope } from "../src/index.ts";
import { collectHandlers } from "./helpers.ts";
import { main as validationMain, validateCrossWorkspace } from "../scripts/validate-cross-workspace.ts";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "node_modules/@unbrained/pm-cli/dist/cli.js");

test("directory and SQLite scopes preserve qualified identities, consent and opaque boundaries without git", async () => {
  const ws = mkdtempSync(join(tmpdir(), "pmg-federation-"));
  const original = { ...process.env };
  const db = new DatabaseSync(join(ws, "scope.sqlite"));
  try {
    const bin = join(ws, "bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    process.env.PATH = bin;
    process.env.HOME = join(ws, "isolated-home");
    process.env.GIT_CEILING_DIRECTORIES = dirname(ws);
    delete process.env.PM_PATH;
    const init = spawnSync(process.execPath, [cli, "init", "--defaults", "--agent-guidance", "skip", "--prefix", "scope"], { cwd: ws, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const pmRoot = join(ws, ".agents/pm");
    const client = new PmClient({ pmRoot, noExtensions: true, author: "projection-test" });
    const first = await client.create({ type: "Task", title: "Delivery", createMode: "progressive" });
    const second = await client.create({ type: "Task", title: "Evidence", createMode: "progressive" });
    await client.update(first.item.id, { blockedBy: second.item.id });
    const snapshot = await listAllComplete({}, { pmRoot, noExtensions: true });
    assert.equal((await validateCrossWorkspace(pmRoot)).sourceItems, 2);
    await validationMain([pmRoot]);
    await assert.rejects(validationMain([]), /Supply one public tracker/);
    db.exec("CREATE TABLE scopes (name TEXT PRIMARY KEY, snapshot TEXT NOT NULL)");
    db.prepare("INSERT INTO scopes VALUES (?, ?)").run("research", JSON.stringify(snapshot));
    let reads = 0;
    const scopes: ProjectionScope[] = [
      { key: "delivery", source: { kind: "directory", pmRoot } },
      { key: "research", source: { kind: "database", read: async () => {
        reads++;
        const row = db.prepare("SELECT snapshot FROM scopes WHERE name = ?").get("research") as { snapshot: string };
        return JSON.parse(row.snapshot) as PmCompleteListResult;
      } } },
    ];
    const evidence: ProjectionEvidence = { from: { workspace: "research", item: second.item.id }, to: { workspace: "delivery", item: first.item.id }, type: "SUPPORTS", consent: true };
    const options: ProjectionOptions = { consent: ["delivery", "research"], authorize: () => true, evidence: [evidence, evidence] };
    const full = await projectWorkspaces(scopes, options);
    assert.equal(full.complete, true);
    assert.equal(full.ok, true);
    assert.equal(reads, 1);
    assert.deepEqual(full.receipt, { scopes: 2, readable: 2, nodes: 4, edges: 3, total: 7, offset: 0, returned: 7, omitted: 0, nextOffset: null });
    assert.equal(new Set(full.rows.filter((row) => row.kind === "node").map((row) => row.id)).size, 4);
    assert.ok(full.rows.some((row) => row.kind === "edge" && row.type === "SUPPORTS"));
    assert.notEqual(qualifyProjectionId("a::b", "c"), qualifyProjectionId("a", "b::c"));
    const page = await projectWorkspaces(scopes, { ...options, limit: 2, offset: 2 });
    assert.deepEqual(page.rows, full.rows.slice(2, 4));
    assert.equal(page.complete, true);
    assert.equal(page.receipt.nextOffset, 4);
    assert.equal(page.receipt.omitted, 5);
    assert.equal((await projectWorkspaces(scopes, { ...options, offset: 100 })).receipt.returned, 0);
    const readBefore = reads;
    for (const authorize of [() => false, () => { throw new Error("hidden-label hidden-node"); }]) {
      const denied = await projectWorkspaces(scopes, { ...options, authorize: (scope) => scope.key === "delivery" || authorize() });
      assert.equal(denied.complete, false);
      assert.equal(denied.receipt.nodes, 2);
      assert.equal(denied.boundaries[0].code, "UNREADABLE");
      assert.equal(denied.boundaries[1].code, "ENDPOINT_UNAVAILABLE");
      assert.doesNotMatch(JSON.stringify(denied), /research|hidden-label|hidden-node/);
    }
    assert.equal(reads, readBefore, "denied database capability must never run");
    const unconsented = await projectWorkspaces(scopes, { ...options, consent: ["delivery"], evidence: [{ ...evidence, consent: false }] });
    assert.equal(unconsented.boundaries[0].code, "CONSENT_REQUIRED");
    assert.equal(unconsented.boundaries[1].code, "CONSENT_REQUIRED");
    const none = await projectWorkspaces(scopes, { ...options, consent: [] });
    assert.equal(none.refusal?.code, "NO_READABLE_SCOPE");
    assert.equal(none.exit_code, 2);
    assert.deepEqual(none.rows, []);
    for (const read of [async () => { throw new Error("private-database private-title"); }, async () => ({ ...snapshot, items: snapshot.items.slice(1) })]) {
      const broken = await projectWorkspaces([{ key: "hidden", source: { kind: "database", read } }], { consent: ["hidden"], authorize: () => true });
      assert.equal(broken.boundaries[0].code, "SOURCE_INCOMPLETE");
      assert.equal(broken.receipt.nodes, 0);
      assert.doesNotMatch(JSON.stringify(broken), /private-database|private-title/);
    }
    const absent = await projectWorkspaces([{ key: "missing", source: { kind: "directory", pmRoot: join(ws, "absent") } }], { consent: ["missing"], authorize: () => true });
    assert.equal(absent.complete, false);
    assert.equal(absent.boundaries[0].code, "SOURCE_INCOMPLETE");
    await client.update(first.item.id, { blockedBy: "missing-private-id" });
    const dangling = await projectWorkspaces(scopes.slice(0, 1), { consent: ["delivery"], authorize: () => true });
    assert.equal(dangling.boundaries[0].code, "DANGLING_RELATION");
    assert.doesNotMatch(JSON.stringify(dangling), /missing-private-id/);

    // The real extension host must retain typed refusals, receipts, JSON and TOON.
    const extensionRoot = join(pmRoot, "extensions/pm-graph");
    mkdirSync(extensionRoot, { recursive: true });
    const artifacts = ["manifest.json", "package.json", "dist"];
    artifacts.forEach((artifact) => cpSync(resolve(root, artifact), resolve(extensionRoot, artifact), { recursive: true }));
    symlinkSync(join(root, "node_modules"), join(extensionRoot, "node_modules"), "dir");
    writeFileSync(join(ws, "projection.json"), JSON.stringify({ scopes: [{ key: "delivery", pmRoot: ".agents/pm" }], consent: ["delivery"] }));
    const run = (args: string[]) => spawnSync(process.execPath, [cli, "pm-graph", "project", ...args], { cwd: ws, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const direct = await collectHandlers().get("pm-graph project")!({ cwd: ws, args: ["projection.json"] }) as ProjectionResult;
    assert.equal(direct.ok, true);
    const json = run(["projection.json", "--json"]);
    assert.equal(json.status, 0, json.stderr || json.stdout);
    assert.equal(JSON.parse(json.stdout).receipt.nodes, 2);
    const toon = run(["projection.json"]);
    assert.equal(toon.status, 0, toon.stderr || toon.stdout);
    assert.match(toon.stdout, /DANGLING_RELATION/);
    const refused = run(["missing.json", "--json"]);
    assert.equal(refused.status, 2, refused.stderr || refused.stdout);
    assert.equal(JSON.parse(refused.stdout).refusal.code, "INVALID_OPTIONS");
    const compact = run(["projection.json", "--output-limit", "1", "--output-budget", "unbounded", "--json"]);
    assert.equal(compact.status, 0, compact.stderr || compact.stdout);
    assert.ok(JSON.parse(compact.stdout).read_output);
  } finally {
    db.close();
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    rmSync(ws, { recursive: true, force: true });
  }
});

test("invalid SDK requests refuse before any source read", async () => {
  const scope: ProjectionScope = { key: "a", source: { kind: "database", read: async () => { assert.fail("must not read"); } } };
  const options: ProjectionOptions = { consent: ["a"], authorize: () => { assert.fail("must not authorize"); } };
  const invalid: unknown[] = [[], [scope, scope], [{ ...scope, key: "" }], [{ ...scope, source: null }], [{ ...scope, source: { kind: "wrong" } }], [{ ...scope, source: { kind: "directory", pmRoot: "" } }], Array(33).fill(scope), null];
  for (const scopes of invalid) assert.equal((await projectWorkspaces(scopes as ProjectionScope[], options)).refusal?.code, "INVALID_OPTIONS");
  for (const patch of [{ limit: 0 }, { limit: 1001 }, { limit: 1.1 }, { offset: -1 }, { offset: NaN }, { consent: ["unknown"] }, { consent: null }, { authorize: null }, { evidence: [null] }, { evidence: [{ type: "BLOCKED_BY" }] }, { evidence: Array(10001).fill({}) }, { evidence: {} }]) {
    const result = await projectWorkspaces([scope], { ...options, ...patch } as ProjectionOptions);
    assert.equal(result.refusal?.code, "INVALID_OPTIONS");
  }
});

test("command validates bounded manifests and flag syntax without reading sources", async () => {
  const ws = mkdtempSync(join(tmpdir(), "pmg-project-input-"));
  const command = collectHandlers().get("pm-graph project")!;
  try {
    writeFileSync(join(ws, "bad.json"), "{");
    writeFileSync(join(ws, "large.json"), "");
    truncateSync(join(ws, "large.json"), 1024 * 1024 + 1);
    for (const args of [[], ["--unknown"], ["--limit"], ["--offset", "-1"], ["a", "b"], ["bad.json"], ["missing.json"], ["large.json"], ["."]]) {
      const result = await command({ cwd: ws, args }) as ProjectionResult;
      assert.equal(result.refusal?.code, "INVALID_OPTIONS", JSON.stringify({ args, result }));
    }
    for (const value of [null, {}, { scopes: [], consent: [null] }, { scopes: [null], consent: [] }, { scopes: [{ key: "a", pmRoot: "" }], consent: [] }, { scopes: [], consent: [], evidence: {} }]) {
      writeFileSync(join(ws, "input.json"), JSON.stringify(value));
      assert.equal((await command({ cwd: ws, args: ["input.json"] }) as ProjectionResult).refusal?.code, "INVALID_OPTIONS");
    }
    writeFileSync(join(ws, "input.json"), JSON.stringify({ scopes: [{ key: "a", pmRoot: "absent" }], consent: [] }));
    const parsed = await command({ cwd: ws, args: ["input.json", "--limit", "1", "--offset", "1", "--json"] }) as ProjectionResult;
    assert.equal(parsed.refusal?.code, "NO_READABLE_SCOPE");
    const help = await command({ args: ["--help"] }) as { usage: string };
    assert.match(help.usage, /project/);
    assert.match(JSON.stringify(await command({ args: ["-h"] })), /manifest/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("facet-shaped missing blockers keep projection incomplete", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pmg-facet-boundary-"));
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(workspace);
  try {
    const tracker = join(workspace, ".agents", "pm");
    const client = new PmClient({ pmRoot: tracker, cwd: workspace, noExtensions: true, author: "projection-test" });
    await client.init("facet", { defaults: true, agentGuidance: "skip", mergeFence: false });
    const first = await client.create({ type: "Task", title: "First task", priority: 0, createMode: "progressive" });
    const second = await client.create({ type: "Task", title: "Second task", priority: 4, createMode: "progressive" });
    const scopes: ProjectionScope[] = [{ key: "tasks", source: { kind: "directory", pmRoot: tracker } }];
    const options: ProjectionOptions = { consent: ["tasks"], authorize: () => true };
    const complete = await projectWorkspaces(scopes, options);
    assert.equal(complete.complete, true, "ordinary type/status facets must not count as missing items");
    assert.equal(complete.receipt.edges, 0);
    for (const target of ["type:task", "status:open"]) {
      await client.update(second.item.id, { blockedBy: target });
      const projected = await projectWorkspaces(scopes, options);
      assert.equal(projected.ok, true);
      assert.equal(projected.complete, false, `missing blocker ${target} must remain an explicit boundary`);
      assert.deepEqual(projected.boundaries.map(({ code }) => code), ["DANGLING_RELATION"]);
      assert.equal(projected.receipt.nodes, 2);
      assert.equal(projected.receipt.edges, 0);
      assert.doesNotMatch(JSON.stringify(projected), /type:task|status:open|PmFacet|ExternalPmItem/);
    }
    await client.update(second.item.id, { blockedBy: first.item.id });
    const resolved = await projectWorkspaces(scopes, options);
    assert.equal(resolved.complete, true);
    assert.equal(resolved.receipt.edges, 1);
  } finally {
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("lone-surrogate evidence identities return typed refusals", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pmg-unicode-boundary-"));
  try {
    const tracker = join(workspace, ".agents", "pm");
    const client = new PmClient({ pmRoot: tracker, cwd: workspace, noExtensions: true, author: "projection-test" });
    await client.init("unicode", { defaults: true, agentGuidance: "skip", mergeFence: false });
    const created = await client.create({ type: "Task", title: "Unicode identity", createMode: "progressive" });
    const scope: ProjectionScope = { key: "scope😀", source: { kind: "directory", pmRoot: tracker } };
    const endpoint = { workspace: scope.key, item: created.item.id };
    const evidence: ProjectionEvidence = { from: endpoint, to: endpoint, type: "EVIDENCE_FOR", consent: true };
    let authorizationCalls = 0;
    const authorize = (): boolean => { authorizationCalls++; return true; };
    for (const invalid of ["\ud800", "\udfff", "prefix\ud800suffix"]) {
      for (const side of ["from", "to"] as const) {
        for (const field of ["workspace", "item"] as const) {
          const malformed = { ...evidence, [side]: { ...endpoint, [field]: invalid } };
          const result = await projectWorkspaces([scope], { consent: [scope.key], authorize, evidence: [malformed] });
          assert.equal(result.ok, false);
          assert.equal(result.refusal?.code, "INVALID_OPTIONS");
          assert.equal(result.exit_code, 2);
          assert.match(result.refusal?.remedy ?? "", /Unicode/);
          assert.deepEqual(result.rows, []);
        }
      }
      const invalidAlias = await projectWorkspaces([{ ...scope, key: invalid }], { consent: [invalid], authorize });
      assert.equal(invalidAlias.refusal?.code, "INVALID_OPTIONS");
    }
    assert.equal(authorizationCalls, 0, "malformed identities must refuse before authorization or source reads");
    const accepted = await projectWorkspaces([scope], { consent: [scope.key], authorize, evidence: [evidence] });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.complete, true);
    assert.equal(accepted.receipt.edges, 1);
    assert.ok(accepted.rows.some((row) => row.kind === "node" && row.id === qualifyProjectionId(scope.key, created.item.id)));
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
