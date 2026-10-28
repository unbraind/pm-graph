import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import type { ItemMetadata } from "@unbrained/pm-cli/sdk";
import { evidencePathInputFromGraph, explainEvidencePath, graphFromItems } from "../src/index.ts";
import type { EvidencePathInput, EvidencePathResult } from "../src/index.ts";
import { collectHandlers, installBuiltGraphExtension, captureStdout } from "./helpers.ts";
import { fingerprint } from "../scripts/tracker-fingerprint.ts";
import { authoritative } from "./event-projection-helpers.ts";
import { validateEvidencePaths, main } from "../scripts/validate-evidence-path.ts";

const root = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "evidence-path-contract-"));
const pmRoot = join(workspace, ".agents", "pm");
const client = new PmClient({ pmRoot, noExtensions: true, author: "evidence-path-test" });
const cli = join(root, "node_modules/@unbrained/pm-cli/dist/cli.js");
const emptyBin = join(workspace, "empty-bin");
const costsFile = join(workspace, "costs.json");
const handler = collectHandlers().get("pm-graph evidence-path")!;
const unset = ["parent", "assignee", "reviewer", "sprint", "release", "blocked_by", "blocked_reason"];
const ids: string[] = [];

/** Invoke the pinned real CLI with no git executable and no possible enclosing repository. */
function run(args: string[]) {
  return spawnSync(process.execPath, [cli, "--pm-path", pmRoot, ...args], { cwd: workspace, encoding: "utf8", timeout: 120000,
    env: { ...process.env, PATH: emptyBin, PM_AUTHOR: "evidence-path-test", GIT_CEILING_DIRECTORIES: dirname(workspace) } });
}

before(async () => {
  mkdirSync(emptyBin);
  const init = run(["--no-extensions", "init", "--defaults", "--agent-guidance", "skip", "--prefix", "reads"]);
  assert.equal(init.status, 0, init.stderr);
  for (let i = 0; i < 6; i++) ids.push((await client.create({ type: "Task", title: `Read fixture ${i}`, createMode: "progressive", unset, clearDeps: true })).item.id);
  for (const [i, targets] of [[0, [1, 2]], [1, [5]], [2, [3]], [3, [5]]] as const)
    await client.update(ids[i], { unset, dep: targets.map((n) => `id=${ids[n]},kind=related_to`), replaceDeps: true });
  writeFileSync(costsFile, JSON.stringify(ids.map((id, i) => ({ id, cost: i === 1 ? 100 : 1 }))));
  installBuiltGraphExtension(pmRoot);
});
after(() => rmSync(workspace, { recursive: true, force: true }));

test("real CLI JSON/TOON has cheaper witness, certified source, lossless paths and no git", () => {
  const before = fingerprint(pmRoot);
  for (const flags of [["--json"], []]) {
    const output = run([...flags, "pm-graph", "evidence-path", ids[0], ids[5], "--edges", "RELATED", "--costs", "costs.json"]);
    assert.equal(output.status, 0, output.stderr || output.stdout);
    if (flags.length) {
      const result = JSON.parse(output.stdout) as EvidencePathResult & { source: { source_complete: boolean } };
      assert.ok(result.ok); assert.equal(result.optimality, "proved"); assert.equal(result.source.source_complete, true);
      assert.deepEqual(result.rows.map((row) => row.cost), [4, 102]);
    } else assert.match(output.stdout, /declared-item-read-cost-v1/);
  }
  const bounded = run(["--json", "pm-graph", "evidence-path", ids[0], ids[5], "--edges", "RELATED", "--costs", costsFile, "--max-work", "1"]);
  assert.equal(bounded.status, 0, bounded.stderr); assert.equal(JSON.parse(bounded.stdout).optimality, "search-limited");
  const limited = run(["--json", "--output-limit", "1", "pm-graph", "evidence-path", ids[0], ids[5], "--edges", "RELATED", "--costs", costsFile]);
  assert.equal(limited.status, 0, limited.stderr); assert.equal(JSON.parse(limited.stdout).has_more, true);
  assert.equal(JSON.parse(limited.stdout).rows.length, 1);
  const help = run(["pm-graph", "evidence-path", "--help"]); assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /max-path-nodes/);
  assert.equal(fingerprint(pmRoot), before);
});

test("CLI failures remain typed and path-free for invalid schemas, files, sources and bounds", async () => {
  const costs = join(workspace, "invalid.json"); writeFileSync(costs, "{invalid");
  const oversized = join(workspace, "oversized.json"); writeFileSync(oversized, " ".repeat(4 * 1024 * 1024 + 1));
  for (const options of [{}, { costs: "" }, { costs: "missing.json" }, { costs }, { costs: workspace }, { costs: oversized }]) {
    const result = await handler({ pm_root: pmRoot, cwd: workspace, args: [ids[0], ids[5]], options }) as EvidencePathResult;
    assert.ok(!result.ok); assert.ok(result.refusal.remedy); assert.ok(!JSON.stringify(result).includes(workspace));
  }
  const missingArgs = await handler({}) as EvidencePathResult; assert.ok(!missingArgs.ok);
  const unreadable = await handler({ pm_root: join(workspace, "absent"), args: [ids[0], ids[5]], options: { costs: costsFile } }) as EvidencePathResult;
  assert.ok(!unreadable.ok); assert.equal(unreadable.refusal.code, "SOURCE_INCOMPLETE");
  for (const options of [{}, { edges: 1 }, { edges: "" }, ...[Infinity, NaN, -1, 0, 1.5, 1000001].map((maxWork) => ({ edges: "RELATED", maxWork }))]) {
    const result = await handler({ pm_root: pmRoot, args: [ids[0], ids[5]], options: { ...options, costs: costsFile } }) as EvidencePathResult;
    assert.ok(!result.ok); assert.equal(result.refusal.code, "INVALID_INPUT");
  }
  writeFileSync(costs, '{"costs":[]}');
  const malformed = run(["--json", "pm-graph", "evidence-path", ids[0], ids[5], "--edges", "RELATED", "--costs", costs]);
  assert.equal(malformed.status, 2, malformed.stderr || malformed.stdout); assert.match(malformed.stdout, /INVALID_INPUT/);
  const invalidBudget = run(["--json", "pm-graph", "evidence-path", ids[0], ids[5], "--edges", "RELATED", "--costs", costsFile, "--max-work", "Infinity"]);
  assert.equal(invalidBudget.status, 2, invalidBudget.stderr || invalidBudget.stdout);
});

test("500 seeded operation sequences replay older inputs and JSON/CRLF without changing SDK state", async () => {
  let state = 0xc0575;
  const random = (max: number): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; };
  const statuses: string[] = [];
  for (const role of ["active", "blocked", "terminal_done", "terminal_canceled"]) {
    const id = `role_${random(1000000)}_${statuses.length}`;
    await client.schemaAddStatus(id, { role: [role] }); statuses.push(id);
  }
  const reference = new Map<string, ItemMetadata>();
  for (const id of ids) reference.set(id, await authoritative(pmRoot, id));
  const old: EvidencePathInput[] = [];
  for (let sequence = 0; sequence < 500; sequence++) {
    await client.focus(ids[random(ids.length)]);
    const i = 1 + random(ids.length - 1); const id = ids[i]; const linked = random(2) === 0;
    // The SDK itself performs every normalization; reference entries are native
    // read-back values, never hand-written whitespace/status approximations.
    await client.update(id, { title: `  sequence ${sequence}\r\n value ${random(80)}  `, type: random(2) ? "Task" : "Feature",
      body: ` body ${random(10)}\r\n whitespace  `, status: statuses[random(statuses.length)], closeReason: "fixture terminal transition", force: true,
      priority: random(5), tags: `tag${random(5)}, Tag ${random(5)}`, deadline: `2027-02-${String(1 + random(28)).padStart(2, "0")}`,
      ...(linked ? { parent: ids[0], blockedBy: ids[0], blockedReason: " reason\r\n next ", assignee: "owner", reviewer: "reviewer", sprint: "iteration", release: "future", dep: [`id=${ids[0]},kind=related_to`], replaceDeps: true }
        : { unset, clearDeps: true }) });
    reference.set(id, await authoritative(pmRoot, id));
    const snapshot = await client.listAllComplete({ includeBody: true });
    const input = evidencePathInputFromGraph(graphFromItems(snapshot.items, ".", new Map(), { includeFacets: false }), {
      from: ids[random(ids.length)], to: ids[random(ids.length)], edgeTypes: ["RELATED", "CHILD_OF", "BLOCKED_BY"],
      costs: ids.map((key) => ({ id: key, cost: random(4) ? random(100) : null })) });
    old.push(input);
    const before = fingerprint(pmRoot);
    for (const candidate of [input, old[random(old.length)]]) {
      const expected = explainEvidencePath(candidate); assert.ok(expected.ok);
      const replay = JSON.parse(JSON.stringify(candidate, null, random(2) ? 2 : 0).replaceAll("\n", "\r\n")) as EvidencePathInput;
      assert.deepEqual(explainEvidencePath(replay), expected);
    }
    assert.equal(fingerprint(pmRoot), before, `read-only bytes, seed 0xc0575 sequence ${sequence}`);
    for (const key of ids) assert.deepEqual(await authoritative(pmRoot, key), reference.get(key), `SDK read-back sequence ${sequence}`);
  }
});

test("aggregate public-copy validator checks cost witnesses and emits no content", async () => {
  const report = await validateEvidencePaths(pmRoot);
  assert.equal(report.inputUnchanged, true); assert.equal(report.sourceComplete, true); assert.ok(Number(report.questions) > 0);
  await assert.rejects(() => main([]), /Supply one/);
  const printed = await captureStdout(() => main([pmRoot])); assert.equal(JSON.parse(printed.stdout).inputUnchanged, true);
  assert.ok(!printed.stdout.includes(pmRoot));
});
