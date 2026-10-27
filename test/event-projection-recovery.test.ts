/** Adversarial storage-presence and event-generation recovery across every projection transport. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { listMutationEvents } from "@unbrained/pm-cli/sdk";
import { refreshEventProjection, readEventProjection, readEventProjectionReceipt, validateEventProjection } from "../src/index.ts";
import type { ProjectionDelta, ProjectionSink } from "../src/index.ts";
import { fixture, seed, assertFull, cli } from "./event-projection-helpers.ts";
import { clearProjectionHistory, FOREIGN_CHECKPOINTS } from "./event-projection-recovery-corpus.ts";
import { installBuiltGraphExtension } from "./helpers.ts";

test("storage presence is independent of all foreign JSON payloads and only a missing file admits", async () => {
  const f = fixture();
  try {
    await seed(f.client, "presence");
    let randomState = 0x175225;
    const payloads = [...FOREIGN_CHECKPOINTS];
    for (let i = 0; i < 100; i++) {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      payloads.push(JSON.stringify([randomState, null, false, `\r\n ${randomState} `]));
    }
    const sink: ProjectionSink = { key: "must-not-apply", apply: async () => { assert.fail("foreign payload must never reach a sink"); } };
    const options = { pmRoot: f.pmRoot, stateFile: f.stateFile, sink };
    for (const bytes of payloads) {
      writeFileSync(f.stateFile, bytes);
      for (const target of [undefined, sink]) for (const rebuild of [false, true]) {
        const result = await refreshEventProjection({ ...options, sink: target, rebuild });
        assert.equal(result.refusal?.code, "FOREIGN_STATE", `payload ${JSON.stringify(bytes)}, rebuild ${rebuild}`);
        assert.equal(readFileSync(f.stateFile, "utf8"), bytes);
      }
      assert.equal(await readEventProjection(f.stateFile), null);
      assert.equal((await readEventProjectionReceipt(f.stateFile)).refusal?.code, "FOREIGN_STATE");
    }
    rmSync(f.stateFile);
    const admitted = await refreshEventProjection({ pmRoot: f.pmRoot, stateFile: f.stateFile });
    assert.equal(admitted.ok, true, JSON.stringify(admitted)); assert.equal(admitted.mode, "admission");
    await assertFull(f);
  } finally { rmSync(f.ws, { recursive: true, force: true }); }
});

test("rebuild resets empty and replacement event generations without resetting sink revision lineage", async () => {
  const f = fixture();
  try {
    const id = await seed(f.client, "generation");
    let revision: string | null = null;
    const transactions: ProjectionDelta[] = [];
    const sink: ProjectionSink = { key: "generation-sink", apply: async (delta) => {
      transactions.push(delta);
      if (delta.revision === revision) return "already_applied";
      if (delta.expected !== revision) return "conflict";
      revision = delta.revision; return "applied";
    } };
    const options = { pmRoot: f.pmRoot, stateFile: f.stateFile, sink };
    assert.equal((await refreshEventProjection(options)).ok, true);
    for (const generation of ["empty", "workspace", "item", "mixed"]) {
      await f.client.update(id, { title: `before reset ${generation}`, unset: ["parent", "assignee", "sprint", "release", "blocked_by", "blocked_reason"], clearDeps: true });
      assert.equal((await refreshEventProjection(options)).ok, true);
      const previous = await readEventProjection(f.stateFile); assert.ok(previous?.anchor);
      clearProjectionHistory(f.pmRoot);
      if (generation === "workspace" || generation === "mixed") await f.client.schemaAddStatus(`reset_${generation}`, { role: ["active"] });
      if (generation === "item" || generation === "mixed") await f.client.update(id, { title: `replacement ${generation}`, unset: ["parent", "assignee", "sprint", "release", "blocked_by", "blocked_reason"], clearDeps: true });
      const page = await listMutationEvents({ pmRoot: f.pmRoot, limit: 1000, full: true });
      assert.equal(page.has_more, false);
      if (generation === "empty") {
        assert.equal(page.count, 0);
        assert.equal((await refreshEventProjection(options)).refusal?.code, "CURSOR_GAP");
      }
      const result = await refreshEventProjection({ ...options, rebuild: true });
      assert.equal(result.ok, true, `generation ${generation}: ${JSON.stringify(result)}`);
      assert.equal(result.mode, "rebuild");
      const rebuilt = await assertFull(options);
      assert.equal(rebuilt.base, previous.revision);
      assert.equal(transactions.at(-1)?.expected, previous.revision);
      assert.equal(rebuilt.cursor, page.next_cursor);
      assert.equal(rebuilt.receipt.cursor, page.next_cursor);
      const versions: Record<string, number> = {};
      for (const event of page.events) versions[event.item_id] = event.version;
      assert.deepEqual(rebuilt.versions, versions);
      if (generation === "empty") for (const field of ["cursor", "anchor"]) assert.equal(Object.hasOwn(rebuilt, field), false);
      const noop = await refreshEventProjection(options);
      assert.equal(noop.ok, true, JSON.stringify(noop)); assert.equal(noop.fullScans, 0);
      await f.client.update(id, { title: `after reset ${generation}`, unset: ["parent", "assignee", "sprint", "release", "blocked_by", "blocked_reason"], clearDeps: true });
      const resumed = await refreshEventProjection(options);
      assert.equal(resumed.ok, true, JSON.stringify(resumed)); assert.equal(resumed.itemReads, 1); assert.equal(resumed.fullScans, 0);
      await assertFull(options);
    }
  } finally { rmSync(f.ws, { recursive: true, force: true }); }
});

test("previous producer checkpoint remains readable and exportable through the unchanged v1 schema", async () => {
  const file = resolve("test/fixtures/event-projection-v1.json");
  const original = readFileSync(file, "utf8");
  assert.equal(validateEventProjection(JSON.parse(original)), true);
  const state = await readEventProjection(file); assert.ok(state?.anchor);
  assert.equal((await readEventProjectionReceipt(file)).revision, state.revision);
  assert.equal(readFileSync(file, "utf8"), original);
});

test("non-git real CLI JSON and TOON preserve foreign payloads and recover empty histories", async () => {
  const f = fixture();
  try {
    const id = await seed(f.client, "transport");
    installBuiltGraphExtension(f.pmRoot);
    const emptyPath = join(f.ws, "no-git"); mkdirSync(emptyPath);
    const run = (args: string[], json: boolean) => spawnSync(process.execPath, [cli, "pm-graph", "refresh", ...args, ...(json ? ["--json"] : [])], {
      cwd: f.ws, encoding: "utf8", timeout: 30000,
      env: { ...process.env, PM_PATH: "", PATH: emptyPath, GIT_CEILING_DIRECTORIES: tmpdir() },
    });
    for (const json of [true, false]) {
      for (const bytes of FOREIGN_CHECKPOINTS) {
        writeFileSync(f.stateFile, bytes);
        for (const flags of [[], ["--rebuild"], ["--receipt"], ["--neo4j", "--rebuild"]]) {
          const result = run(["projection.json", ...flags], json);
          assert.equal(result.status, 2, result.stdout + result.stderr);
          if (json) assert.equal(JSON.parse(result.stdout).refusal.code, "FOREIGN_STATE");
          else assert.match(result.stdout, /FOREIGN_STATE/);
          assert.equal(readFileSync(f.stateFile, "utf8"), bytes);
        }
      }
    }
    rmSync(f.stateFile);
    assert.equal(run(["projection.json"], true).status, 0);
    for (const json of [true, false]) {
      await f.client.update(id, { title: `CLI epoch ${json}`, unset: ["parent", "assignee", "sprint", "release", "blocked_by", "blocked_reason"], clearDeps: true });
      assert.equal(run(["projection.json"], true).status, 0);
      const before = await readEventProjection(f.stateFile); assert.ok(before?.anchor);
      clearProjectionHistory(f.pmRoot);
      const result = run(["projection.json", "--rebuild"], json);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      if (json) assert.equal(JSON.parse(result.stdout).mode, "rebuild"); else assert.match(result.stdout, /mode: "?rebuild"?/);
      const rebuilt = await assertFull(f);
      assert.equal(Object.hasOwn(rebuilt, "cursor"), false); assert.equal(Object.hasOwn(rebuilt, "anchor"), false);
      assert.deepEqual(rebuilt.versions, {});
      assert.equal(run(["projection.json"], json).status, 0);
    }
    const prior = run([resolve("test/fixtures/event-projection-v1.json"), "--receipt"], true);
    assert.equal(prior.status, 0, prior.stdout + prior.stderr);
  } finally { rmSync(f.ws, { recursive: true, force: true }); }
});
