/**
 * Behavioural coverage for remaining pm-graph command, Neo4j, and helper
 * paths. Drives the real SDK harness against throwaway workspaces. Neo4j
 * success and error-mapping paths use the in-process driver fake registered
 * below so handlers run without a Bolt server.
 */

import { registerHooks } from "node:module";

import { resolve as resolveNeo4j } from "./fixtures/neo4j-fake-loader.ts";

registerHooks({ resolve: resolveNeo4j });

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { runRegisteredServiceOverrideForTest } from "@unbrained/pm-cli/sdk/testing";

import {
  explainItem,
  analyzeGraph,
  criticalConnectors,
  dependencyDepths,
  findCycles,
  longestChain,
  topoSort,
  renderAnalysisDiagram,
  renderGraphml,
  shortestPath,
} from "../src/index.ts";
import {
  type CmdResult,
  type CommandError,
  captureStdout,
  makeHarness,
  pm,
  pmAvailable,
  restoreEnv,
} from "./helpers.ts";
import {
  fakeInteger,
  fakeNode,
  fakePath,
  fakeRecord,
  fakeRelationship,
  getFakeNeo4jCalls,
  getFakeNeo4jLastConfig,
  getFakeNeo4jLastSessionConfig,
  getFakeNeo4jLastUri,
  resetFakeNeo4j,
  setFakeNeo4jFail,
  setFakeNeo4jRead,
  wasFakeNeo4jClosed,
} from "./fixtures/neo4j-fake.ts";

/** Create a task item with extra CLI args and return its id. */
function createItemWithExtra(cwd: string, title: string, extra: string[] = []): string {
  const out = pm(cwd, ["create", "Task", title, "--json", ...extra]);
  const created = JSON.parse(out) as { id?: string; item?: { id: string } };
  return (created.item?.id ?? created.id) as string;
}

/** Create a fresh workspace with the pm-graph- prefix. */
function freshWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "pm-graph-"));
}

function setNeo4jEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const original = { ...process.env };
  process.env.NEO4J_URI = overrides.NEO4J_URI ?? "bolt://127.0.0.1:17687";
  if (overrides.NEO4J_USER !== undefined) {
    if (overrides.NEO4J_USER === "") delete process.env.NEO4J_USER;
    else process.env.NEO4J_USER = overrides.NEO4J_USER;
  } else {
    process.env.NEO4J_USER = "neo4j";
  }
  if (overrides.NEO4J_USERNAME !== undefined) {
    process.env.NEO4J_USERNAME = overrides.NEO4J_USERNAME;
  }
  process.env.NEO4J_PASSWORD = overrides.NEO4J_PASSWORD ?? "secret";
  if (overrides.NEO4J_DATABASE) process.env.NEO4J_DATABASE = overrides.NEO4J_DATABASE;
  if (overrides.NEO4J_CONNECTION_TIMEOUT_MS) {
    process.env.NEO4J_CONNECTION_TIMEOUT_MS = overrides.NEO4J_CONNECTION_TIMEOUT_MS;
  } else {
    delete process.env.NEO4J_CONNECTION_TIMEOUT_MS;
  }
  if (overrides.NEO4J_MAX_RETRY_MS) {
    process.env.NEO4J_MAX_RETRY_MS = overrides.NEO4J_MAX_RETRY_MS;
  } else {
    delete process.env.NEO4J_MAX_RETRY_MS;
  }
  return original;
}

test("Neo4j timeout parsing is exercised through the real sync command", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  const original = setNeo4jEnv();
  try {
    pm(ws, ["init"]);
    const harness = await makeHarness();
    const pmRoot = path.join(ws, ".agents", "pm");
    const cases: Array<[string | undefined, number | undefined]> = [
      [undefined, undefined],
      ["   ", undefined],
      ["abc", undefined],
      ["-5", undefined],
      ["12.4", 12],
      [`${"9".repeat(400)}`, undefined],
      ["300", 300],
    ];
    for (const [raw, expected] of cases) {
      if (raw === undefined) delete process.env.NEO4J_CONNECTION_TIMEOUT_MS;
      else process.env.NEO4J_CONNECTION_TIMEOUT_MS = raw;
      resetFakeNeo4j();
      const result = (await harness.runCommand({ command: "pm-graph sync", pmRoot })) as CmdResult;
      assert.equal(result.errorMessage, undefined);
      assert.equal(getFakeNeo4jLastConfig()?.connectionTimeout, expected);
    }
  } finally {
    restoreEnv(original);
    rmSync(ws, { recursive: true, force: true });
  }
});

test("offline analytics cover dangling edges, ties, cycles, components, and sparse properties", () => {
  const edges = [
    { from: "a", to: "b", type: "DEPENDS_ON" },
    { from: "b", to: "c", type: "DEPENDS_ON" },
    { from: "c", to: "b", type: "BLOCKED_BY" },
    { from: "a", to: "e", type: "DEPENDS_ON" },
    { from: "missing", to: "a", type: "DEPENDS_ON" },
  ] as Parameters<typeof longestChain>[1];
  assert.deepEqual(longestChain(["a", "b", "c", "d", "e"], edges), ["a", "b", "c"]);
  const rotatedCycleEdges = [
    { from: "z", to: "b", type: "DEPENDS_ON" },
    { from: "b", to: "a", type: "DEPENDS_ON" },
    { from: "a", to: "z", type: "DEPENDS_ON" },
  ] as Parameters<typeof findCycles>[1];
  assert.deepEqual(findCycles(["z", "b", "a"], rotatedCycleEdges), [["a", "z", "b", "a"]]);
  assert.deepEqual(
    shortestPath(
      [
        { from: "a", to: "b", type: "DEPENDS_ON" },
        { from: "a", to: "c", type: "DEPENDS_ON" },
        { from: "b", to: "d", type: "DEPENDS_ON" },
        { from: "c", to: "d", type: "DEPENDS_ON" },
        { from: "d", to: "e", type: "DEPENDS_ON" },
      ],
      "a",
      "e",
    ),
    ["a", "b", "d", "e"],
  );
  assert.deepEqual(topoSort(["a", "b", "c", "d", "e"], edges), {
    order: ["d", "e"],
    cycleNodes: ["a", "b", "c"],
  });
  assert.deepEqual(dependencyDepths(["a", "b", "c", "d", "e"], edges).get("d"), 0);
  const connectors = criticalConnectors(["a", "b", "c", "d", "e"], edges);
  assert.ok(connectors.articulationPoints.includes("a"));
  assert.ok(connectors.bridges.length > 0);

  const nodes = ["a", "b", "c", "d", "e"].map((id) => ({
    id,
    labels: ["PmItem"],
    properties: { id, title: id, status: "open" },
  }));
  const graph = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    workspace: "/tmp/demo",
    projectKey: "demo",
    nodes,
    relationships: [
      ...edges.filter((edge) => edge.from !== "missing").map((edge) => ({ ...edge, properties: {} })),
      { ...edges[0], properties: {} },
      { from: "a", to: "unknown", type: "DEPENDS_ON", properties: {} },
    ],
  } as Parameters<typeof analyzeGraph>[0];
  const report = analyzeGraph(graph);
  assert.equal(report.orphanCount, 1);
  assert.ok(report.rootCount >= 1);
  assert.ok(report.leafCount >= 1);
  assert.ok(report.cycleCount >= 1);

  const sparseGraph = {
    ...graph,
    nodes: [
      { id: "sparse", labels: ["PmItem"], properties: { id: "sparse" } },
      { id: "neighbor-b", labels: ["PmItem"], properties: { id: "neighbor-b" } },
      { id: "neighbor-a", labels: ["PmItem"], properties: { id: "neighbor-a" } },
    ],
    relationships: [
      { from: "sparse", to: "neighbor-b", type: "DEPENDS_ON", properties: {} },
      { from: "sparse", to: "neighbor-a", type: "DEPENDS_ON", properties: {} },
    ],
  } as Parameters<typeof explainItem>[0];
  const sparseReport = explainItem(sparseGraph, "sparse");
  assert.ok(sparseReport);
  assert.equal(sparseReport.item.title, "sparse");
  assert.equal(sparseReport.item.status, "unknown");
  assert.deepEqual(sparseReport.blockers.map((neighbor) => neighbor.id), ["neighbor-a", "neighbor-b"]);
});

test("explainItem returns null for an unknown id and reports cycle membership", () => {
  const graph = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    workspace: "/tmp/demo",
    projectKey: "demo",
    nodes: [
      { id: "A", labels: ["PmItem"], properties: { title: "A", type: "Task", status: "open" } },
      { id: "B", labels: ["PmItem"], properties: { title: "B", type: "Task", status: "open" } },
    ],
    relationships: [
      { from: "A", to: "B", type: "BLOCKED_BY", properties: {} },
      { from: "B", to: "A", type: "BLOCKED_BY", properties: {} },
    ],
  };
  assert.equal(explainItem(graph, "missing"), null);
  const report = explainItem(graph, "A");
  assert.ok(report);
  assert.equal(report.inCycle, true);
  assert.ok(report.cycleCount >= 1);
});

test("analyzeGraph reports blocked items, roots, leaves, and connectors", () => {
  const graph = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    workspace: "/tmp/demo",
    projectKey: "demo",
    nodes: [
      { id: "root", labels: ["PmItem"], properties: { title: "root" } },
      { id: "mid", labels: ["PmItem"], properties: { title: "mid" } },
      { id: "leaf", labels: ["PmItem"], properties: { title: "leaf" } },
      { id: "orphan", labels: ["PmItem"], properties: { title: "orphan" } },
      { id: "other", labels: ["PmItem"], properties: { title: "other" } },
    ],
    relationships: [
      { from: "mid", to: "root", type: "BLOCKED_BY", properties: {} },
      { from: "leaf", to: "mid", type: "BLOCKED_BY", properties: {} },
      { from: "other", to: "root", type: "CHILD_OF", properties: {} },
    ],
  };
  const report = analyzeGraph(graph, 2);
  assert.ok(report.blockedItems.includes("mid"));
  assert.ok(report.orphans.includes("orphan"));
  assert.ok(report.roots.includes("root") || report.leafCount >= 1);
  assert.equal(report.topDegreeCentrality.length <= 2, true);
});

test("renderers tolerate missing titles and empty relationship lists", () => {
  const graph = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    workspace: "/tmp/demo",
    projectKey: "demo",
    nodes: [{ id: "A", labels: ["PmItem"], properties: { title: 12, status: 1 } }],
    relationships: [],
  };
  const mermaid = renderAnalysisDiagram("mermaid", graph);
  assert.match(mermaid, /graph TD/);
  assert.match(mermaid, /n_A/);
  const xml = renderGraphml(graph);
  assert.match(xml, /<graphml/);
});

test("output_format declines a raw marker whose payload is not a string", async () => {
  const harness = await makeHarness();
  const outcome = await runRegisteredServiceOverrideForTest(harness.activation.services, {
    service: "output_format",
    command: "pm-graph export",
    payload: { command: "pm-graph export", result: { __pmGraphRawOutput: 15 } },
  } as Parameters<typeof runRegisteredServiceOverrideForTest>[1]);
  assert.equal(outcome.handled, false);
});

const HELP_COMMANDS = [
  "pm-graph export",
  "pm-graph cypher",
  "pm-graph sync",
  "pm-graph query",
  "pm-graph neighbors",
  "pm-graph analyze",
  "pm-graph cycles",
  "pm-graph path",
  "pm-graph critical-path",
  "pm-graph topo-sort",
  "pm-graph impact",
  "pm-graph explain",
] as const;

test("every command --help and -h returns usage text", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const harness = await makeHarness();
    const pmRoot = path.join(ws, ".agents", "pm");
    for (const command of HELP_COMMANDS) {
      const help = (await harness.runCommand({ command, args: ["--help"], pmRoot })) as CmdResult;
      assert.equal(help.handled, true, `${command} --help handled`);
      const helpResult = help.result as { usage: string };
      assert.ok(typeof helpResult.usage === "string" && helpResult.usage.includes("pm-graph"), `${command} usage`);

      const shortHelp = (await harness.runCommand({ command, args: ["-h"], pmRoot })) as CmdResult;
      assert.equal(shortHelp.handled, true, `${command} -h handled`);
      const shortResult = shortHelp.result as { usage: string };
      assert.equal(shortResult.usage, helpResult.usage, `${command} -h matches --help`);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("export flag errors and --output writing cover the remaining branches", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const alpha = createItemWithExtra(ws, "Alpha", ["--tags", "backend", "--assignee", "ada", "--sprint", "s1", "--release", "r1"]);
    createItemWithExtra(ws, "Beta", ["--parent", alpha, "--blocked-by", alpha, "--tags", " ,core"]);
    createItemWithExtra(ws, "External", ["--dep", "id=external-target,kind=blocks", "--allow-unresolved-deps"]);
    const alphaFile = path.join(ws, ".agents", "pm", "tasks", `${alpha}.toon`);
    writeFileSync(alphaFile, `${readFileSync(alphaFile, "utf-8")}\ndeps[1]{foo}:\n  bar\n`);
    const harness = await makeHarness();
    const pmRoot = path.join(ws, ".agents", "pm");

    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph export", args: ["--edges", "bogus"], pmRoot }),
      (err: CommandError) => {
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /Unknown --edges/);
        return true;
      },
    );
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph export", args: ["--root"], pmRoot }),
      (err: CommandError) => {
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /--root requires an item id/);
        return true;
      },
    );
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph export", args: ["--root", "   "], pmRoot }),
      (err: CommandError) => {
        assert.match(err.message, /--root requires an item id/);
        return true;
      },
    );
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph export", args: ["--depth", "2"], pmRoot }),
      (err: CommandError) => {
        assert.match(err.message, /--depth requires --root/);
        return true;
      },
    );
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph export", args: ["--root", alpha, "--depth", "nope"], pmRoot }),
      (err: CommandError) => {
        assert.match(err.message, /Invalid --depth/);
        return true;
      },
    );
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph export", args: ["--filter"], pmRoot }),
      (err: CommandError) => {
        assert.match(err.message, /--filter requires a value/);
        return true;
      },
    );
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph export", args: ["--output"], pmRoot }),
      (err: CommandError) => {
        assert.match(err.message, /--output requires a file path/);
        return true;
      },
    );
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph export", args: ["--output", "graph.json"], pmRoot }),
      (err: CommandError) => {
        assert.match(err.message, /--output requires --format/);
        return true;
      },
    );
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph export", args: ["--format"], pmRoot }),
      (err: CommandError) => {
        assert.match(err.message, /--format requires a value/);
        return true;
      },
    );
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph export", args: ["--format", "svg"], pmRoot }),
      (err: CommandError) => {
        assert.match(err.message, /Unknown --format/);
        return true;
      },
    );
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph export", args: ["--format", "json", "--root", "no-such-item"], pmRoot }),
      (err: CommandError) => {
        assert.equal(err.exitCode, 3);
        assert.match(err.message, /was not found/);
        return true;
      },
    );
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph export", args: ["--format", "json", "--output", ws], pmRoot }),
      (err: CommandError) => {
        assert.match(err.message, /Export failed/);
        return true;
      },
    );

    const outFile = path.join(ws, "shaped.mermaid");
    const written = (await harness.runCommand({
      command: "pm-graph export",
      args: ["--format=mermaid", "--output", outFile, "--edges", "all", "--filter=type=task", "--include-closed"],
      pmRoot,
    })) as CmdResult;
    const writtenResult = written.result as { ok: boolean; file: string; format: string };
    assert.equal(writtenResult.ok, true);
    assert.equal(writtenResult.format, "mermaid");
    assert.equal(existsSync(outFile), true);
    assert.match(readFileSync(outFile, "utf-8"), /graph TD/);

    const jsonGraph = (await harness.runCommand({
      command: "pm-graph export",
      args: ["--json", "--root", alpha, "--depth", "1", "--edges", "deps"],
      pmRoot,
    })) as CmdResult;
    const graph = (jsonGraph.result as { graph: { workspace: string; nodes: Array<{ id: string }> } }).graph;
    assert.ok(graph.nodes.some((n) => n.id === alpha));
    assert.equal(graph.workspace, ws);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("export and sync wrap unexpected graph-loading errors", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const harness = await makeHarness();
    const exportHandler = harness.activation.commands.handlers.find((entry) => entry.command === "pm-graph export");
    const syncHandler = harness.activation.commands.handlers.find((entry) => entry.command === "pm-graph sync");
    assert.ok(exportHandler);
    assert.ok(syncHandler);
    const brokenExportContext = {
      command: "pm-graph export",
      args: [],
      options: {},
      global: { json: true },
      get pm_root(): string {
        throw new Error("graph export boom");
      },
    } as unknown as Parameters<typeof exportHandler.run>[0];
    await assert.rejects(
      async () => exportHandler.run(brokenExportContext),
      /Export failed: graph export boom/,
    );
    const brokenSyncContext = {
      command: "pm-graph sync",
      args: [],
      options: {},
      global: { json: true },
      get pm_root(): string {
        throw new Error("graph sync boom");
      },
    } as unknown as Parameters<typeof syncHandler.run>[0];
    await assert.rejects(
      async () => syncHandler.run(brokenSyncContext),
      (err: CommandError) => {
        assert.equal(err.exitCode, 1);
        assert.match(err.message, /Failed to load workspace graph: graph sync boom/);
        return true;
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("impact wraps a failure while resolving the canonical graph engine", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const id = createItemWithExtra(ws, "Alpha");
    const harness = await makeHarness();
    const impactHandler = harness.activation.commands.handlers.find((entry) => entry.command === "pm-graph impact");
    assert.ok(impactHandler);
    const tracker = path.join(ws, ".agents", "pm");
    let reads = 0;
    const brokenAfterLoad = {
      command: "pm-graph impact",
      args: [id],
      options: {},
      global: { json: true },
      get pm_root(): string {
        reads++;
        return reads <= 2 ? tracker : path.join(ws, "missing-after-load");
      },
    } as unknown as Parameters<typeof impactHandler.run>[0];
    await assert.rejects(
      async () => impactHandler.run(brokenAfterLoad),
      (err: CommandError) => {
        assert.equal(err.exitCode, 1);
        assert.match(err.message, /Failed to run pm graph impact: Tracker is not initialized/);
        return true;
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("graph-export exporter writes files, filters, and rejects empty output", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const alpha = createItemWithExtra(ws, "Alpha");
    const harness = await makeHarness();
    const pmRoot = path.join(ws, ".agents", "pm");
    const outFile = path.join(ws, "export.dot");

    const implicitOptions = (await harness.runExporter({ exporter: "graph-export", pmRoot })) as CmdResult;
    assert.equal((implicitOptions.result as { ok: boolean }).ok, true);
    const originalCwd = process.cwd();
    try {
      process.chdir(ws);
      const implicitRoot = (await harness.runExporter({ exporter: "graph-export", options: { format: "json" } })) as CmdResult;
      assert.ok(implicitRoot.result);
    } finally {
      process.chdir(originalCwd);
    }

    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph export", args: ["--edges"], pmRoot }),
      /Unknown --edges/,
    );

    const { result } = await captureStdout(async () =>
      harness.runExporter({
        exporter: "graph-export",
        options: { format: "dot", output: outFile, filter: ["type=task"], root: alpha, depth: 2, edges: "deps" },
        pmRoot,
      }),
    );
    const written = result as CmdResult;
    const payload = written.result as { ok: boolean; file: string; format: string };
    assert.equal(payload.format, "dot");
    assert.equal(existsSync(outFile), true);

    const { stdout } = await captureStdout(async () =>
      harness.runExporter({
        exporter: "graph-export",
        options: { format: "json", filter: "status=open", "include-closed": true },
        pmRoot,
      }),
    );
    const parsed = JSON.parse(stdout) as { graph?: { nodes?: unknown[] }; nodes?: unknown[] };
    assert.ok(parsed.graph?.nodes ?? parsed.nodes);

    await assert.rejects(
      () => harness.runExporter({ exporter: "graph-export", options: { format: "json", output: "   " }, pmRoot }),
      /--output requires a file path/,
    );

    const notATracker = path.join(ws, "not-a-tracker");
    mkdirSync(notATracker, { recursive: true });
    await assert.rejects(
      () => harness.runExporter({ exporter: "graph-export", options: { format: "json" }, pmRoot: notATracker }),
      /tracker|pm tracker|Could not locate/i,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("custom .pm tracker root still exports and names the parent workspace", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    createItemWithExtra(ws, "Alpha");
    const hidden = path.join(ws, ".pm");
    mkdirSync(hidden, { recursive: true });
    writeFileSync(path.join(hidden, "settings.json"), readFileSync(path.join(ws, ".agents", "pm", "settings.json"), "utf-8"));
    mkdirSync(path.join(hidden, "schema"), { recursive: true });
    for (const name of ["fields.json", "statuses.json", "types.json", "workflows.json"]) {
      const src = path.join(ws, ".agents", "pm", "schema", name);
      if (existsSync(src)) writeFileSync(path.join(hidden, "schema", name), readFileSync(src, "utf-8"));
    }
    const harness = await makeHarness();
    const res = (await harness.runCommand({ command: "pm-graph export", args: ["--json"], pmRoot: hidden })) as CmdResult;
    const graph = (res.result as { graph: { workspace: string; nodes: unknown[] } }).graph;
    assert.equal(graph.workspace, ws);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("cypher, neighbors, query, and explain remaining error surfaces", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const a = createItemWithExtra(ws, "Alpha");
    const b = createItemWithExtra(ws, "Beta", ["--blocked-by", a]);
    pm(ws, ["update", a, "--blocked-by", b]);
    const harness = await makeHarness();
    const pmRoot = path.join(ws, ".agents", "pm");

    const cypher = (await harness.runCommand({ command: "pm-graph cypher", pmRoot })) as CmdResult;
    assert.equal((cypher.result as { ok: boolean }).ok, true);

    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph path", args: ["pm-zzz", a], pmRoot }),
      (err: CommandError) => {
        assert.equal(err.exitCode, 3);
        assert.match(err.message, /Did you mean/);
        return true;
      },
    );

    const cypherMissing = (await harness.runCommand({
      command: "pm-graph cypher",
      pmRoot: path.join(ws, "missing-tracker"),
    })) as CmdResult;
    assert.match(
      String(cypherMissing.errorMessage ?? ""),
      /Cypher generation failed|No pm tracker/,
    );

    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph neighbors", args: ["--json"], pmRoot }),
      (err: CommandError) => {
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /Usage: pm pm-graph neighbors/);
        return true;
      },
    );

    const explained = (await harness.runCommand({ command: "pm-graph explain", args: [a], pmRoot })) as CmdResult;
    const report = explained.result as { inCycle: boolean; cycleCount: number };
    assert.equal(report.inCycle, true);
    assert.ok(report.cycleCount >= 1);

    const { stdout } = await captureStdout(async () =>
      harness.runCommand({ command: "pm-graph impact", args: [a, "--include-closed", "--format", "mermaid"], pmRoot }),
    );
    assert.match(stdout, /graph TD/);
    const limited = (await harness.runCommand({ command: "pm-graph impact", args: [a, "--limit", "1"], pmRoot })) as CmdResult;
    assert.equal(limited.errorMessage, undefined);
    const bothDirections = (await harness.runCommand({ command: "pm-graph impact", args: [a, "--direction", "both"], pmRoot })) as CmdResult;
    assert.equal(bothDirections.errorMessage, undefined);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

describe("neo4j command success and friendly errors", { concurrency: 1, skip: !pmAvailable }, () => {
  test("ping reports configured Neo4j when credentials are present", async () => {
    const ws = freshWorkspace();
    const original = setNeo4jEnv();
    try {
      pm(ws, ["init"]);
      const harness = await makeHarness();
      const res = (await harness.runCommand({
        command: "pm-graph ping",
        pmRoot: path.join(ws, ".agents", "pm"),
      })) as CmdResult;
      const result = res.result as { neo4jConfigured: boolean };
      assert.equal(result.neo4jConfigured, true);
    } finally {
      restoreEnv(original);
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("sync incremental and --full write through the fake driver", async () => {
    const ws = freshWorkspace();
    const original = setNeo4jEnv({
      NEO4J_DATABASE: "neo4j",
      NEO4J_CONNECTION_TIMEOUT_MS: "400",
      NEO4J_MAX_RETRY_MS: "0",
    });
    resetFakeNeo4j();
    try {
      pm(ws, ["init"]);
      createItemWithExtra(ws, "Alpha");
      const harness = await makeHarness();
      const pmRoot = path.join(ws, ".agents", "pm");

      const incremental = (await harness.runCommand({ command: "pm-graph sync", pmRoot })) as CmdResult;
      const inc = incremental.result as { ok: boolean; syncedNodes: number; deletedStaleNodes: number; fullSync: boolean };
      assert.equal(inc.ok, true);
      assert.equal(inc.fullSync, false);
      assert.ok(inc.syncedNodes >= 1);
      assert.equal(inc.deletedStaleNodes, 2);
      assert.equal(getFakeNeo4jLastUri(), "bolt://127.0.0.1:17687");
      assert.equal(getFakeNeo4jLastConfig()?.connectionTimeout, 400);
      assert.equal(getFakeNeo4jLastConfig()?.maxTransactionRetryTime, 0);
      assert.equal(getFakeNeo4jLastSessionConfig()?.database, "neo4j");
      assert.equal(wasFakeNeo4jClosed(), true);
      assert.ok(getFakeNeo4jCalls().some((c) => c.mode === "write" && c.query.includes("DETACH DELETE")));

      resetFakeNeo4j();
      const full = (await harness.runCommand({ command: "pm-graph sync", args: ["--full"], pmRoot })) as CmdResult;
      const fullResult = full.result as { fullSync: boolean };
      assert.equal(fullResult.fullSync, true);
      assert.ok(getFakeNeo4jCalls().some((c) => c.query.includes("DETACH DELETE") && c.query.includes("projectKey")));
    } finally {
      restoreEnv(original);
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("sync on an empty tracker skips stale-node deletion", async () => {
    const ws = freshWorkspace();
    const original = setNeo4jEnv();
    resetFakeNeo4j();
    try {
      pm(ws, ["init"]);
      const harness = await makeHarness();
      const res = (await harness.runCommand({
        command: "pm-graph sync",
        pmRoot: path.join(ws, ".agents", "pm"),
      })) as CmdResult;
      const result = res.result as { syncedNodes: number; deletedStaleNodes: number };
      assert.equal(result.deletedStaleNodes, 0);
      assert.ok(result.syncedNodes >= 0);
    } finally {
      restoreEnv(original);
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("status reads counts including Neo4j Integer and missing records", async () => {
    const ws = freshWorkspace();
    const original = setNeo4jEnv({ NEO4J_USER: "", NEO4J_USERNAME: "neo4j" });
    resetFakeNeo4j();
    try {
      pm(ws, ["init"]);
      createItemWithExtra(ws, "Alpha");
      const harness = await makeHarness();
      const pmRoot = path.join(ws, ".agents", "pm");

      setFakeNeo4jRead((query) => {
        if (query.includes("RETURN count(n)")) return { records: [fakeRecord({ count: fakeInteger(4) })] };
        if (query.includes("RETURN count(r)")) return { records: [fakeRecord({ count: 7 })] };
        if (query.includes("PmGraphSync")) {
          return { records: [fakeRecord({ lastSyncedAt: "2026-01-01T00:00:00.000Z", syncVersion: "2026.9.13" })] };
        }
        return { records: [] };
      });
      const res = (await harness.runCommand({ command: "pm-graph status", pmRoot })) as CmdResult;
      const result = res.result as {
        neo4jConfigured: boolean;
        nodeCount: number;
        relationshipCount: number;
        lastSyncedAt: unknown;
        localItemCount: number;
      };
      assert.equal(result.neo4jConfigured, true);
      assert.equal(result.nodeCount, 4);
      assert.equal(result.relationshipCount, 7);
      assert.equal(result.lastSyncedAt, "2026-01-01T00:00:00.000Z");
      assert.equal(result.localItemCount, 1);

      resetFakeNeo4j();
      setFakeNeo4jRead(() => ({ records: [] }));
      const empty = (await harness.runCommand({ command: "pm-graph status", pmRoot })) as CmdResult;
      const emptyResult = empty.result as { nodeCount: number; relationshipCount: number; lastSyncedAt: unknown };
      assert.equal(emptyResult.nodeCount, 0);
      assert.equal(emptyResult.relationshipCount, 0);
      assert.equal(emptyResult.lastSyncedAt, null);
    } finally {
      restoreEnv(original);
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("query converts Integer, Node, Relationship, Path, arrays, and objects", async () => {
    const ws = freshWorkspace();
    const original = setNeo4jEnv();
    resetFakeNeo4j();
    try {
      pm(ws, ["init"]);
      const harness = await makeHarness();
      const node = fakeNode(["PmGraphNode"], { id: "A", title: "Alpha" }, "el-1");
      const rel = fakeRelationship("BLOCKED_BY", { source: "blocked_by" }, {
        elementId: "rel-1",
        startNodeElementId: "el-1",
        endNodeElementId: "el-2",
      });
      const endOnlyRelationship = { type: "RELATES_TO", properties: { source: "end-only" }, endNodeElementId: "el-2" };
      const pathValue = fakePath(node, node, [{ start: node, relationship: rel, end: node }], 1);
      const preservedFunction = () => "preserved";
      const preservedSymbol = Symbol("preserved");
      setFakeNeo4jRead(() => ({
        records: [
          fakeRecord({
            n: node,
            r: rel,
            rEnd: endOnlyRelationship,
            p: pathValue,
            i: fakeInteger(9),
            s: "plain",
            z: null,
            arr: [fakeInteger(1), { nested: true }],
            obj: { k: "v" },
            preservedFunction,
            preservedSymbol,
          }),
        ],
      }));
      const res = (await harness.runCommand({
        command: "pm-graph query",
        args: ["MATCH (n) RETURN n"],
        pmRoot: path.join(ws, ".agents", "pm"),
      })) as CmdResult;
      const result = res.result as { ok: boolean; count: number; records: Array<Record<string, unknown>> };
      assert.equal(result.ok, true);
      assert.equal(result.count, 1);
      const row = result.records[0];
      assert.equal(row.i, 9);
      assert.equal(row.s, "plain");
      assert.equal(row.z, null);
      const n = row.n as { _labels: string[]; _elementId: string; title: string };
      assert.deepEqual(n._labels, ["PmGraphNode"]);
      assert.equal(n._elementId, "el-1");
      assert.equal(n.title, "Alpha");
      const r = row.r as { _type: string; _startNodeElementId: string };
      assert.equal(r._type, "BLOCKED_BY");
      assert.equal(r._startNodeElementId, "el-1");
      const rEnd = row.rEnd as { _type: string; _startNodeElementId?: string; _endNodeElementId: string };
      assert.equal(rEnd._type, "RELATES_TO");
      assert.equal(rEnd._startNodeElementId, undefined);
      assert.equal(rEnd._endNodeElementId, "el-2");
      const p = row.p as { length: number; segments: unknown[] };
      assert.equal(p.length, 1);
      assert.equal(p.segments.length, 1);
      assert.deepEqual(row.arr, [1, { nested: true }]);
      assert.deepEqual(row.obj, { k: "v" });
      assert.equal(row.preservedFunction, preservedFunction);
      assert.equal(row.preservedSymbol, preservedSymbol);
    } finally {
      restoreEnv(original);
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("Neo4j command cleanup failures still close through every command finally", async () => {
    const ws = freshWorkspace();
    const original = setNeo4jEnv();
    try {
      pm(ws, ["init"]);
      createItemWithExtra(ws, "Alpha");
      const harness = await makeHarness();
      const pmRoot = path.join(ws, ".agents", "pm");
      for (const closeMode of ["session", "driver"] as const) {
        process.env.PM_GRAPH_TEST_CLOSE_FAIL = closeMode;
        for (const [command, args] of [
          ["pm-graph query", ["MATCH (n) RETURN n"]],
          ["pm-graph neighbors", ["TASK-1"]],
          ["pm-graph status", []],
          ["pm-graph sync", []],
        ] as const) {
          resetFakeNeo4j();
          const result = (await harness.runCommand({ command, args, pmRoot })) as CmdResult;
          assert.match(String(result.errorMessage), /Neo4j (session|driver) close failed/);
        }
      }
    } finally {
      delete process.env.PM_GRAPH_TEST_CLOSE_FAIL;
      restoreEnv(original);
      rmSync(ws, { recursive: true, force: true });
    }
  });

test("neighbors returns center+edges and the empty-node message", async () => {
    const ws = freshWorkspace();
    const original = setNeo4jEnv();
    resetFakeNeo4j();
    try {
      pm(ws, ["init"]);
      const harness = await makeHarness();
      const pmRoot = path.join(ws, ".agents", "pm");
      const center = fakeNode(["PmGraphNode"], { id: "TASK-1" }, "c1");
      const neighbor = fakeNode(["PmGraphNode"], { id: "TASK-2" }, "n1");
      const rel = fakeRelationship("BLOCKED_BY", { source: "x" }, { startNodeElementId: "c1", endNodeElementId: "n1" });
      setFakeNeo4jRead(() => ({
        records: [
          fakeRecord({
            center,
            neighbor,
            r: rel,
            relType: "BLOCKED_BY",
            direction: "outgoing",
          }),
        ],
      }));
      const found = (await harness.runCommand({
        command: "pm-graph neighbors",
        args: ["TASK-1"],
        pmRoot,
      })) as CmdResult;
      const foundResult = found.result as { center: { id: string }; neighbors: unknown[] };
      assert.equal(foundResult.center.id, "TASK-1");
      assert.equal(foundResult.neighbors.length, 1);

      resetFakeNeo4j();
      setFakeNeo4jRead(() => ({ records: [] }));
      const missing = (await harness.runCommand({
        command: "pm-graph neighbors",
        args: ["TASK-99"],
        pmRoot,
      })) as CmdResult;
      const missingResult = missing.result as { center: null; message: string };
      assert.equal(missingResult.center, null);
      assert.match(missingResult.message, /No node found/);
    } finally {
      restoreEnv(original);
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("Neo4j commands map auth, non-Error, generic, and connection failures", async () => {
    const ws = freshWorkspace();
    const original = setNeo4jEnv();
    resetFakeNeo4j();
    try {
      pm(ws, ["init"]);
      createItemWithExtra(ws, "Alpha");
      const harness = await makeHarness();
      const pmRoot = path.join(ws, ".agents", "pm");

      const authErr = new Error("Unauthorized");
      (authErr as Error & { code: string }).code = "Neo.ClientError.Security.Unauthorized";
      setFakeNeo4jFail(authErr);
      const authRes = (await harness.runCommand({
        command: "pm-graph query",
        args: ["MATCH (n) RETURN n"],
        pmRoot,
      })) as CmdResult;
      assert.match(String(authRes.errorMessage), /authentication failed/i);

      setFakeNeo4jFail("not-an-error");
      const rawRes = (await harness.runCommand({
        command: "pm-graph neighbors",
        args: ["TASK-1"],
        pmRoot,
      })) as CmdResult;
      assert.match(String(rawRes.errorMessage), /not-an-error/);

      setFakeNeo4jFail(new Error("Cypher syntax error"));
      const genericRes = (await harness.runCommand({ command: "pm-graph status", pmRoot })) as CmdResult;
      assert.match(String(genericRes.errorMessage), /Cypher syntax error/);

      const noMessage = new Error("temporary");
      Object.defineProperty(noMessage, "message", { value: undefined });
      setFakeNeo4jFail(noMessage);
      const noMessageRes = (await harness.runCommand({ command: "pm-graph status", pmRoot })) as CmdResult;
      assert.equal(noMessageRes.handled, false);

      const conn = new Error("Failed to connect to server");
      setFakeNeo4jFail(conn);
      const connRes = (await harness.runCommand({ command: "pm-graph sync", pmRoot })) as CmdResult;
      assert.match(String(connRes.errorMessage), /not reachable/);

      process.env.PM_GRAPH_TEST_DROP_URI = "1";
      setFakeNeo4jFail(new Error("ECONNREFUSED"));
      const defaultUriRes = (await harness.runCommand({ command: "pm-graph sync", pmRoot })) as CmdResult;
      assert.match(String(defaultUriRes.errorMessage), /bolt:\/\/localhost:7687/);
      delete process.env.PM_GRAPH_TEST_DROP_URI;
    } finally {
      restoreEnv(original);
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("createDriver throws USAGE when credentials are incomplete", async () => {
    const ws = freshWorkspace();
    const original = { ...process.env };
    delete process.env.NEO4J_URI;
    delete process.env.NEO4J_USER;
    delete process.env.NEO4J_USERNAME;
    delete process.env.NEO4J_PASSWORD;
    process.env.NEO4J_URI = "bolt://127.0.0.1:9";
    try {
      pm(ws, ["init"]);
      const harness = await makeHarness();
      await assert.rejects(
        () => harness.runCommand({ command: "pm-graph query", args: ["MATCH (n) RETURN n"], pmRoot: path.join(ws, ".agents", "pm") }),
        (err: CommandError) => {
          assert.equal(err.exitCode, 2);
          assert.match(err.message, /NEO4J_USER|NEO4J_PASSWORD|not configured/);
          return true;
        },
      );
    } finally {
      restoreEnv(original);
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

test("root discovery wraps missing trackers and preserves typed tracker errors", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  const originalCwd = process.cwd();
  try {
    const harness = await makeHarness();
    process.chdir(ws);
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph analyze" }),
      (err: CommandError) => {
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /No pm tracker/);
        return true;
      },
    );

    mkdirSync(path.join(ws, ".agents", "pm"), { recursive: true });
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph analyze" }),
      (err: CommandError) => {
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /not a pm tracker/);
        return true;
      },
    );

    const analyzeHandler = harness.activation.commands.handlers.find((entry) => entry.command === "pm-graph analyze");
    assert.ok(analyzeHandler);
    const brokenContext = {
      command: "pm-graph analyze",
      args: [],
      options: {},
      global: { json: true },
      get workspaceRoot(): string {
        throw new Error("workspace getter failed");
      },
    } as unknown as Parameters<typeof analyzeHandler.run>[0];
    await assert.rejects(
      async () => analyzeHandler.run(brokenContext),
      (err: CommandError) => {
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /Could not locate a pm tracker: workspace getter failed/);
        return true;
      },
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(ws, { recursive: true, force: true });
  }
});

test("registered handlers support omitted optional context fields", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    createItemWithExtra(ws, "Alpha");
    const harness = await makeHarness();
    const tracker = path.join(ws, ".agents", "pm");
    for (const entry of harness.activation.commands.handlers) {
      const context = {
        command: entry.command,
        options: {},
        global: { json: true },
        pm_root: tracker,
      } as unknown as Parameters<typeof entry.run>[0];
      await Promise.resolve(entry.run(context)).catch((err: unknown) => {
        if (!(err instanceof Error) || err.name !== "CommandError") throw err;
      });
    }

    const analyzeHandler = harness.activation.commands.handlers.find((entry) => entry.command === "pm-graph analyze");
    assert.ok(analyzeHandler);
    for (const rootField of ["workspaceRoot", "cwd"] as const) {
      const context = {
        command: "pm-graph analyze",
        args: [],
        options: {},
        global: { json: true },
        [rootField]: ws,
      } as unknown as Parameters<typeof analyzeHandler.run>[0];
      await analyzeHandler.run(context);
    }
    const originalCwd = process.cwd();
    try {
      process.chdir(ws);
      const context = {
        command: "pm-graph analyze",
        args: [],
        options: {},
        global: { json: true },
      } as unknown as Parameters<typeof analyzeHandler.run>[0];
      await analyzeHandler.run(context);
    } finally {
      process.chdir(originalCwd);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("fetching an unreadable tracker reports a wrapped SDK failure", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const tracker = path.join(ws, ".agents", "pm");
    chmodSync(tracker, 0o111);
    const harness = await makeHarness();
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph export", args: ["--json"], pmRoot: tracker }),
      (err: CommandError) => {
        assert.equal(err.exitCode, 1);
        assert.match(err.message, /Failed to read pm items|readable|permission/i);
        return true;
      },
    );
  } finally {
    chmodSync(path.join(ws, ".agents", "pm"), 0o755);
    rmSync(ws, { recursive: true, force: true });
  }
});

test("status swallows an unusable tracker when counting local items", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  const original = { ...process.env };
  try {
    delete process.env.NEO4J_URI;
    delete process.env.NEO4J_USER;
    delete process.env.NEO4J_USERNAME;
    delete process.env.NEO4J_PASSWORD;
    const harness = await makeHarness();
    const res = (await harness.runCommand({
      command: "pm-graph status",
      pmRoot: path.join(ws, "not-a-tracker"),
    })) as CmdResult;
    const result = res.result as { localItemCount: number; neo4jConfigured: boolean; ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(result.localItemCount, 0);
    assert.equal(result.neo4jConfigured, false);
  } finally {
    restoreEnv(original);
    rmSync(ws, { recursive: true, force: true });
  }
});
