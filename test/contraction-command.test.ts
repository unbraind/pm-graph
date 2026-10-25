import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { contractGraph, graphFromItems } from "../src/index.ts";
import type { ContractionResult, ContractionInput } from "../src/index.ts";
import { installBuiltGraphExtension, collectHandlers, captureStdout } from "./helpers.ts";
import { main, validateContraction } from "../scripts/validate-contraction.ts";

const root = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "contraction-contract-"));
const pmRoot = join(workspace, ".agents", "pm");
const client = new PmClient({ pmRoot, noExtensions: true, author: "contraction-test" });
const cliPackage = JSON.parse(readFileSync(join(root, "node_modules/@unbrained/pm-cli/package.json"), "utf8")) as { bin: { pm: string } };
const cli = join(root, "node_modules/@unbrained/pm-cli", cliPackage.bin.pm);
const emptyBin = join(workspace, "empty-bin");
const handler = collectHandlers().get("pm-graph contract")!;
let a = ""; let b = "";

/** Invoke the real pinned host with no git executable and discovery stopped above the fixture. */
function run(args: string[]) {
  return spawnSync(process.execPath, [cli, "--pm-path", pmRoot, ...args], { cwd: workspace,
    env: { ...process.env, PATH: emptyBin, PM_AUTHOR: "contraction-test", GIT_CEILING_DIRECTORIES: dirname(workspace) }, encoding: "utf8", timeout: 120000 });
}

before(async () => {
  mkdirSync(emptyBin);
  const init = run(["--no-extensions", "init", "--defaults", "--agent-guidance", "skip", "--prefix", "contract"]);
  assert.equal(init.status, 0, init.stderr);
  a = (await client.create({ type: "Task", title: "Boundary A" })).item.id;
  b = (await client.create({ type: "Task", title: "Boundary B", blockedBy: a, parent: a, dep: [`type=related,id=${a}`], tags: "one,two", priority: 2,
    assignee: "agent", sprint: "iteration", release: "future", deadline: "2027-01-01", body: "Body\r\nwith whitespace  " })).item.id;
  installBuiltGraphExtension(pmRoot);
});
after(() => rmSync(workspace, { recursive: true, force: true }));

test("real CLI JSON/TOON, membership, refusals and source certification work without git", () => {
  for (const flags of [["--json"], []]) {
    const output = run([...flags, "pm-graph", "contract", a, b, "--edges", "BLOCKED_BY"]);
    assert.equal(output.status, 0, output.stderr || output.stdout);
    if (flags.length) {
      const result = JSON.parse(output.stdout) as ContractionResult & { source: { source_complete: boolean } };
      assert.ok(result.ok); assert.ok(result.source.source_complete);
      assert.match(output.stdout, /witness/);
    } else assert.match(output.stdout, /stored-directed-reachability-v1/);
  }
  const expanded = run(["--json", "pm-graph", "contract", a, b, "--edges", "BLOCKED_BY", "--expand", "g0", "--limit", "1", "--offset", "0"]);
  assert.equal(expanded.status, 0, expanded.stderr || expanded.stdout);
  assert.match(expanded.stdout, /member/);
  for (const tail of [["absent", "--edges", "BLOCKED_BY"], [a], [a, "--edges", "BLOCKED_BY", "--limit", "Infinity"]]) {
    const result = run(["--json", "pm-graph", "contract", ...tail]);
    assert.equal(result.status, 2, result.stderr || result.stdout);
  }
});

test("unreadable sources refuse without partial rows; option extremes share the SDK schema", async () => {
  const missing = await handler({ pm_root: join(workspace, "absent"), args: [a], options: { edges: "E" } }) as ContractionResult;
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.refusal.code, "SOURCE_INCOMPLETE");
  const absentArgs = await handler({ pm_root: pmRoot, options: { edges: "BLOCKED_BY" } }) as ContractionResult;
  assert.equal(absentArgs.ok, false);
  const absentOptions = await handler({ pm_root: pmRoot, args: [a] }) as ContractionResult;
  assert.equal(absentOptions.ok, false);
  for (const limit of [NaN, Infinity, -1, 0, 1.5, 1001]) {
    const result = await handler({ pm_root: pmRoot, args: [a], options: { edges: "BLOCKED_BY", limit } }) as ContractionResult;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.refusal.code, "INVALID_INPUT");
  }
});

test("500 seeded read-only export/replay sequences compare state read back through the SDK with the reference snapshot", async () => {
  const initial = await client.listAllComplete({ includeBody: true });
  const reference = structuredClone(initial.items);
  const inputs: ContractionInput[] = [];
  let seed = 0x51a7e;
  for (let sequence = 0; sequence < 500; sequence++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const current = await client.listAllComplete({ includeBody: true });
    assert.deepEqual(current.items, reference, `SDK state before sequence ${sequence}`);
    const graph = graphFromItems(current.items, ".", new Map(), { includeFacets: false });
    const input: ContractionInput = { nodes: graph.nodes.map(({ id }) => ({ id })), edges: graph.relationships.map(({ from, to, type }) => ({ from, to, type })), boundary: seed % 2 ? [a] : [a, b], edgeTypes: ["BLOCKED_BY"], limit: 1000 };
    inputs.push(input);
    for (const candidate of [input, inputs[seed % inputs.length]]) {
      const replay = JSON.parse(JSON.stringify(candidate, null, seed % 2 ? 2 : 0).replace(/\n/g, "\r\n")) as ContractionInput;
      const result = contractGraph(replay);
      assert.ok(result.ok);
      assert.deepEqual(result, contractGraph(candidate));
    }
    assert.deepEqual((await client.listAllComplete({ includeBody: true })).items, reference, `SDK state after sequence ${sequence}`);
  }
});

test("random custom registry names and roles never hide nodes or reinterpret statuses", async () => {
  for (let i = 0; i < 12; i++) {
    const name = `custom_${(Math.imul(i + 1, 2654435761) >>> 0).toString(36)}`;
    const role = ["active", "blocked", "terminal_done", "terminal_canceled"][i % 4];
    await client.schemaAddStatus(name, { role: [role] });
    const id = (await client.create({ type: "Task", title: `Registry fixture ${i}` })).item.id;
    await client.update(id, { status: name, ...(role === "terminal_done" || role === "terminal_canceled" ? { closeReason: "Fixture terminal state" } : {}) });
    const result = await handler({ pm_root: pmRoot, args: [id], options: { edges: "BLOCKED_BY" } }) as ContractionResult;
    assert.ok(result.ok);
    if (result.ok) assert.ok(result.rows.some((row) => row.kind === "group" && row.members.includes(id)));
  }
});

test("public-copy validation emits finite aggregate evidence and preserves tracker records", async () => {
  const result = await validateContraction(pmRoot);
  assert.equal(result.inputUnchanged, true); assert.equal(result.sourceComplete, true);
  assert.equal(result.boundaryPairsChecked, 64);
  await assert.rejects(() => main([]), /Supply one/);
  const printed = await captureStdout(() => main([pmRoot]));
  assert.equal((JSON.parse(printed.stdout) as { inputUnchanged: boolean }).inputUnchanged, true);
  const blank = mkdtempSync(join(tmpdir(), "contraction-empty-"));
  try {
    const blankClient = new PmClient({ pmRoot: join(blank, ".agents", "pm"), noExtensions: true, author: "contraction-test" });
    await blankClient.init("blank", { defaults: true, agentGuidance: "skip" });
    await assert.rejects(() => validateContraction(join(blank, ".agents", "pm")), /nonempty/);
    await blankClient.create({ type: "Task", title: "Isolated node" });
    assert.equal((await validateContraction(join(blank, ".agents", "pm"))).boundaryPairsChecked, 1);
    // A complete associative graph forces >1000 summary rows and exercises the
    // validator's page collection against real SDK state, with no SDK doubles.
    const ids = (await blankClient.listAllComplete()).items.map((item) => item.id);
    for (let i = 1; i < 34; i++) ids.push((await blankClient.create({ type: "Task", title: `Pagination node ${i}` })).item.id);
    for (const id of ids) await blankClient.update(id, { dep: ids.filter((target) => target !== id).map((target) => `type=related,id=${target}`) });
    const paginated = await validateContraction(join(blank, ".agents", "pm"));
    assert.equal(paginated.nodes, 34);
    assert.ok(Number(paginated.summaryEdges) > 1000);
    assert.equal(paginated.boundaryPairsChecked, 64);
    assert.equal(paginated.inputUnchanged, true);
  } finally { rmSync(blank, { recursive: true, force: true }); }
});
