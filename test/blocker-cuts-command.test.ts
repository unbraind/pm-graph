import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { PmClient, type ContractsResult } from "@unbrained/pm-cli/sdk";
import { registerBlockerCuts } from "../src/blocker-cuts-command.ts";
import type { BlockerCutCommandRefusal } from "../src/blocker-cuts-command.ts";
import type { BlockerCutResult } from "../src/blocker-cuts.ts";
import type { ExtensionApi } from "../src/index.ts";
import { installBuiltGraphExtension, captureStdout, collectHandlers } from "./helpers.ts";
import { main as replayMain, validateBlockerCuts } from "../scripts/validate-blocker-cuts.ts";

const root = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "blocker-cuts-contract-"));
const pmRoot = join(workspace, ".agents", "pm");
const emptyPath = join(workspace, "empty-bin");
const host = JSON.parse(readFileSync(join(root, "node_modules/@unbrained/pm-cli/package.json"), "utf8")) as { bin: { pm: string } };
const cli = join(root, "node_modules/@unbrained/pm-cli", host.bin.pm);
const env = { ...process.env, PM_AUTHOR: "contract-test", GIT_CEILING_DIRECTORIES: dirname(workspace) };
const client = new PmClient({ pmRoot, noExtensions: true, author: "contract-test" });
const handler = collectHandlers().get("pm-graph blocker-cuts")!;
let goal = "";
let blocker = "";
let upstream = "";

/** Execute the installed host, optionally removing git and every other executable from PATH. */
function run(args: string[], noGit = false) {
  return spawnSync(process.execPath, [cli, "--pm-path", pmRoot, ...args], {
    cwd: workspace, env: { ...env, ...(noGit ? { PATH: emptyPath } : {}) }, encoding: "utf8", timeout: 120_000,
  });
}

/** Register injected command boundaries while retaining the real tracker SDK reads. */
function customHandler(resolveRoot: Parameters<typeof registerBlockerCuts>[1], project: Parameters<typeof registerBlockerCuts>[2]): typeof handler {
  let registered: typeof handler = handler;
  const api = {
    registerCommand: (command) => { registered = command.run; },
    registerExporter: () => {},
    registerService: () => {},
  } satisfies ExtensionApi;
  registerBlockerCuts(api, resolveRoot, project);
  return registered;
}

before(async () => {
  mkdirSync(emptyPath);
  const initialized = run(["--no-extensions", "init", "--defaults", "--agent-guidance", "skip", "--prefix", "cuts"]);
  assert.equal(initialized.status, 0, initialized.stderr);
  upstream = (await client.create({ type: "Task", title: "Prerequisite" })).item.id;
  blocker = (await client.create({ type: "Task", title: "Intermediate", blockedBy: upstream })).item.id;
  goal = (await client.create({ type: "Task", title: "Goal", blockedBy: blocker })).item.id;
  // Load the built package through the real host, retaining its exact dependencies.
  installBuiltGraphExtension(pmRoot);
});
after(() => rmSync(workspace, { recursive: true, force: true }));

test("projection defects propagate instead of becoming source refusals", async () => {
  const failure = new Error("projection defect");
  let projectCalls = 0;
  const projectedHandler = customHandler((context) => context.pm_root!, (items, root) => {
    projectCalls++;
    assert.equal(root, pmRoot);
    assert.equal(items.length, 3);
    throw failure;
  });
  await assert.rejects(() => projectedHandler({ pm_root: pmRoot, args: [goal] }), (error) => error === failure);
  assert.equal(projectCalls, 1);
  const unreadable = await projectedHandler({ pm_root: join(workspace, "absent"), args: [goal] }) as BlockerCutCommandRefusal;
  assert.equal(unreadable.code, "SOURCE_INCOMPLETE");
  assert.equal(projectCalls, 1);
});

for (const [label, cause, message] of [
  ["Error", new Error("tracker root lookup failed"), "tracker root lookup failed"],
  ["non-Error", "tracker lookup refused", "tracker lookup refused"],
] as const) {
  test(`source refusals preserve ${label} causes`, async () => {
    const sourceHandler = customHandler(() => { throw cause; }, () => { throw new Error("projection must not run"); });
    const result = await sourceHandler({ pm_root: pmRoot, args: [goal] }) as BlockerCutCommandRefusal;
    assert.equal(result.ok, false);
    assert.equal(result.code, "SOURCE_INCOMPLETE");
    assert.equal(result.exit_code, 2);
    assert.deepEqual(result.cuts, []);
    assert.ok(result.refusal.remedy.endsWith(`Cause: ${message}`), result.refusal.remedy);
    assert.equal(result.remediation, result.refusal.remedy);
    assert.match(result.remediation, /pm list --all --full --strict-read/);
  });
}

test("real CLI returns JSON and TOON from a non-git tracker with no git executable", () => {
  const json = run(["--json", "pm-graph", "blocker-cuts", goal], true);
  assert.equal(json.status, 0, json.stderr || json.stdout);
  const result = JSON.parse(json.stdout) as BlockerCutResult & { source: { item_count: number; source_complete: boolean } };
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.cuts.map((cut) => cut.blockers), [[blocker], [upstream]].sort((a, b) => a[0].localeCompare(b[0])));
  assert.equal(result.source.item_count, 3);
  assert.equal(result.source.source_complete, true);
  assert.equal(result.receipt.search.complete, true);
  const toon = run(["pm-graph", "blocker-cuts", goal], true);
  assert.equal(toon.status, 0, toon.stderr);
  assert.match(toon.stdout, /upstream-frontier/);
  assert.match(toon.stdout, /immediatelyUnblocked/);
  assert.ok(Buffer.byteLength(json.stdout) < 12_000);
  const compact = run(["--json", "pm-graph", "blocker-cuts", goal, "--output-limit", "1", "--output-budget", "unbounded"], true);
  assert.equal(compact.status, 0, compact.stderr);
  const projected = JSON.parse(compact.stdout) as { cuts: unknown[]; read_output: unknown };
  assert.equal(projected.cuts.length, 1);
  assert.ok(projected.read_output);
});

test("CLI flags, usage and source failures retain typed actionable refusals", async () => {
  for (const args of [[], [goal, "extra"]]) {
    const result = await handler({ pm_root: pmRoot, args }) as BlockerCutCommandRefusal;
    assert.equal(result.code, "INVALID_OPTIONS");
    assert.equal(result.exit_code, 2);
  }
  for (const value of ["abc", -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const result = await handler({ pm_root: pmRoot, args: [goal], options: { maxStates: value } }) as BlockerCutCommandRefusal;
    assert.equal(result.code, "INVALID_OPTIONS");
    assert.equal(result.exit_code, 2);
    assert.deepEqual(result.cuts, []);
    assert.ok(result.refusal.remedy);
  }
  const help = run(["pm-graph", "blocker-cuts", "--help"], true);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--max-states/);
  const sourceFailure = await handler({ pm_root: join(workspace, "absent"), args: [goal] }) as BlockerCutCommandRefusal;
  assert.equal(sourceFailure.code, "SOURCE_INCOMPLETE");
  assert.ok(sourceFailure.refusal.remedy.endsWith(`Cause: No pm tracker at ${join(workspace, "absent")}`));
  const missing = run(["--json", "pm-graph", "blocker-cuts", "absent"], true);
  assert.equal(missing.status, 3, missing.stderr || missing.stdout);
  assert.match(missing.stderr + missing.stdout, /UNKNOWN_GOAL/);
  const bounded = await handler({ pm_root: pmRoot, args: [goal], options: { maxStates: 1, maxWork: 500, maxCuts: 8, maxSize: 2 } }) as BlockerCutResult;
  assert.equal(bounded.receipt.search.reason, "maxStates");
  const cliBounded = run(["--json", "pm-graph", "blocker-cuts", goal, "--max-states", "1"], true);
  assert.equal(cliBounded.status, 0, cliBounded.stdout + cliBounded.stderr);
  const limited = JSON.parse(cliBounded.stdout) as BlockerCutResult;
  assert.equal(limited.receipt.search.reason, "maxStates");
  assert.equal(limited.receipt.search.complete, false);
});

test("host contracts advertise numeric cut budgets and normalize both CLI spellings without git", () => {
  const contracts = run(["contracts", "--command", "pm-graph blocker-cuts", "--json"], true);
  assert.equal(contracts.status, 0, contracts.stderr);
  const inventory = JSON.parse(contracts.stdout) as ContractsResult;
  const command = inventory.command_flags?.find((entry) => entry.command === "pm-graph blocker-cuts");
  assert.ok(command, "blocker-cuts has a workspace flag contract");
  for (const flag of ["--max-states", "--max-work", "--max-cuts", "--max-size"]) {
    assert.equal(command.flags.find((entry) => entry.flag === flag)?.value_type, "number", flag);
  }
  const budgets = ["max-states", "1", "max-work", "500", "max-cuts", "8", "max-size", "2"];
  const separated = run(["--json", "pm-graph", "blocker-cuts", goal, ...budgets.flatMap((value, index) => index % 2 === 0 ? [`--${value}`] : [value])], true);
  const equals = run(["--json", "pm-graph", "blocker-cuts", goal, ...budgets.flatMap((value, index) => index % 2 === 0 ? [`--${value}=${budgets[index + 1]}`] : [])], true);
  assert.equal(separated.status, 0, separated.stderr);
  assert.equal(equals.status, 0, equals.stderr || equals.stdout);
  const left = JSON.parse(separated.stdout) as BlockerCutResult;
  const right = JSON.parse(equals.stdout) as BlockerCutResult;
  assert.ok(left.ok);
  assert.ok(right.ok);
  assert.deepEqual(right.cuts, left.cuts);
  assert.deepEqual(right.receipt, left.receipt);
  assert.equal(right.receipt.search.reason, "maxStates");
  for (const value of ["abc", "-1", "0", "1.5"]) {
    const malformed = run(["--json", "pm-graph", "blocker-cuts", goal, `--max-states=${value}`], true);
    assert.equal(malformed.status, 2, malformed.stderr || malformed.stdout);
    assert.match(malformed.stderr + malformed.stdout, /INVALID_OPTIONS|positive integer/);
    assert.doesNotMatch(malformed.stdout, /"search"/);
  }
});

test("cycles and missing references use the same source and graph receipts", async () => {
  const replay = await validateBlockerCuts(pmRoot);
  assert.equal(replay.goals, 3);
  assert.equal(replay.inputUnchanged, true);
  await assert.rejects(() => replayMain([]), /Supply a read-only public tracker copy/);
  const replayOutput = await captureStdout(() => replayMain([pmRoot]));
  const receipt = JSON.parse(replayOutput.stdout) as { goals: number; inputUnchanged: boolean };
  assert.equal(receipt.goals, 3);
  assert.equal(receipt.inputUnchanged, true);
  await client.update(upstream, { blockedBy: blocker });
  const cyclic = await validateBlockerCuts(pmRoot);
  assert.deepEqual(cyclic.refusals, { CYCLE: 3 });
  const cycle = await handler({ pm_root: pmRoot, args: [goal] }) as BlockerCutCommandRefusal;
  assert.equal(cycle.code, "CYCLE");
  assert.ok(cycle.receipt!.graph.cycle.length > 0);
  const cliCycle = run(["--json", "pm-graph", "blocker-cuts", goal], true);
  assert.equal(cliCycle.status, 2, cliCycle.stdout + cliCycle.stderr);
  const cycleReceipt = JSON.parse(cliCycle.stdout) as BlockerCutCommandRefusal;
  assert.equal(cycleReceipt.refusal.code, "CYCLE");
  assert.deepEqual(cycleReceipt.receipt!.graph.cycle, cycle.receipt!.graph.cycle);
  assert.ok(cycleReceipt.source!.source_complete);
  await client.update(upstream, { blockedBy: "" });
  // A missing reference is a legitimate external item and must not be silently dropped.
  await client.update(upstream, { blockedBy: "cuts-external" });
  const missingReference = await handler({ pm_root: pmRoot, args: [goal] }) as BlockerCutCommandRefusal;
  assert.equal(missingReference.code, "INCOMPLETE_GRAPH");
  await client.update(upstream, { blockedBy: "" });
  // Strict certified reads must refuse malformed corpus rows rather than proving an empty graph.
  const broken = join(pmRoot, "tasks", "cuts-broken.toon");
  writeFileSync(broken, "invalid tracker data\n");
  try {
    const malformed = await handler({ pm_root: pmRoot, args: [goal] }) as BlockerCutCommandRefusal;
    assert.equal(malformed.code, "SOURCE_INCOMPLETE");
  } finally { rmSync(broken); }
});
