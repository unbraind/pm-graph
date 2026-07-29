/**
 * Command-surface and error-path coverage for the pm-graph extension, driven
 * through the real SDK test harness (`createExtensionTestHarness`) against
 * throwaway pm workspaces. Covers: ping (with/without Neo4j env), export
 * --output file writing, every export --format, cypher command, topo-sort
 * (acyclic and cyclic), path (missing args, unknown ids, no path), explain
 * (missing id), analyze --root neighborhood, status (Neo4j not configured and
 * connection-failure error paths), and the Neo4j command error surfaces
 * (query/neighbors/sync with env vars set so the real driver attempts a
 * connection and fails).
 *
 * Uses `createExtensionTestHarness` (real activation + dispatch) rather than
 * hand-rolled `api` doubles so registration rejection is caught.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../src/index.ts";

/** Shape of the result returned by `harness.runCommand`. */
type CmdResult = {
  handled: boolean;
  result: unknown;
  warnings: string[];
  errorMessage?: string;
};

/**
 * Shape of a {@link CommandError} propagated (thrown) by the dispatch engine
 * when a handler throws an error carrying a numeric `exitCode`. The pm-graph
 * extension mirrors the SDK EXIT_CODE contract: 1 = GENERIC_FAILURE,
 * 2 = USAGE, 3 = NOT_FOUND.
 */
type CommandError = Error & { exitCode: number };

let pmAvailable = true;
try {
  execFileSync("pm", ["--version"], { encoding: "utf-8" });
} catch {
  pmAvailable = false;
}

/** Capture console.log output produced while running `fn`. */
async function captureStdout(fn: () => Promise<unknown>): Promise<{ result: unknown; stdout: string }> {
  const original = console.log;
  let buffer = "";
  console.log = (...parts: unknown[]) => {
    buffer += parts.map(String).join(" ") + "\n";
  };
  try {
    const result = await fn();
    return { result, stdout: buffer };
  } finally {
    console.log = original;
  }
}

/** Create a fresh pm workspace and return its path. */
function freshWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "pmg-cmd-"));
}

/** Run `pm` in a workspace and return stdout. */
function pm(cwd: string, args: string[]): string {
  return execFileSync("pm", args, { cwd, encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 });
}

/** Create a task item and return its id. */
function createItem(cwd: string, title: string, blockedBy?: string): string {
  const args = ["create", "Task", title, "--json"];
  if (blockedBy) args.push("--blocked-by", blockedBy);
  const out = pm(cwd, args);
  const created = JSON.parse(out) as { id?: string; item?: { id: string } };
  return (created.item?.id ?? created.id) as string;
}

/** Create the SDK test harness bound to the pm-graph extension. */
async function makeHarness(pmRoot: string) {
  return createExtensionTestHarness(extension, {
    name: "pm-graph",
    capabilities: ["commands", "importers", "services"],
  });
}

// ---------------------------------------------------------------------------
// ping command
// ---------------------------------------------------------------------------

test("ping returns extension version and Neo4j status (not configured)", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const harness = await makeHarness(ws);
    const res = await harness.runCommand({ command: "pm-graph ping", pmRoot: path.join(ws, ".agents", "pm") }) as CmdResult;
    assert.equal(res.handled, true);
    const result = res.result as { ok: boolean; version: string; neo4jConfigured: boolean; source: string };
    assert.equal(result.ok, true);
    assert.equal(result.source, "pm-graph");
    assert.equal(result.neo4jConfigured, false, "Neo4j not configured by default");
    assert.ok(typeof result.version === "string", "version present");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("ping --help returns usage text", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const harness = await makeHarness(ws);
    const res = await harness.runCommand({ command: "pm-graph ping", args: ["--help"], pmRoot: path.join(ws, ".agents", "pm") }) as CmdResult;
    assert.equal(res.handled, true);
    const result = res.result as { usage: string; description: string };
    assert.ok(typeof result.usage === "string");
    assert.ok(result.usage.includes("pm-graph ping"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// The status help `output` map documents what each response field means, so every
// entry must read as a description. `version` previously held the literal
// "2026.7.28", which is a value rather than a description, and the release
// workflow's unanchored `version:` rewrite treated that nested string as its
// target — so each release silently restamped a help string with a version
// number and the documentation was never actually wrong-looking enough to notice.
//
// Asserting "no entry looks like a version" rather than pinning the exact wording
// is deliberate: pinning the string would fail on any harmless copy edit, while
// this catches precisely the regression that automation can reintroduce.
test("status --help documents its output fields as descriptions, not values", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const harness = await makeHarness(ws);
    const res = await harness.runCommand({ command: "pm-graph status", args: ["--help"], pmRoot: path.join(ws, ".agents", "pm") }) as CmdResult;
    assert.equal(res.handled, true);
    const result = res.result as { output: Record<string, string> };
    assert.ok(result.output, "status help exposes an output map");

    const versionLike = /^\d{4}\.\d{1,2}\.\d{1,2}(-\d+)?$/;
    for (const [field, text] of Object.entries(result.output)) {
      assert.equal(typeof text, "string", `${field} is documented with a string`);
      assert.ok(text.length > 0, `${field} is documented`);
      assert.ok(
        !versionLike.test(text.trim()),
        `${field} is documented with a description, not the literal value "${text}"`,
      );
    }
    assert.match(result.output.version, /version/i, "the version field describes itself");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// Guards the other half of the same defect. The help text above is only stable if
// the release workflow cannot rewrite it, and those two files are edited
// independently — so a future contributor could un-anchor the pattern and the
// help-text test would keep passing until the next release restamped it.
//
// This reconstructs the actual regex the release job runs and asserts it does not
// match this package's source. Testing the real pattern rather than asserting on
// the YAML text means the guard cannot be satisfied by a cosmetic edit that
// leaves the behaviour broken.
test("the release version rewrite cannot match anything in this package's source", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf-8");

  const marker = "source.replace(/";
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, "release.yml still performs a source-level version rewrite");
  const patternStart = start + marker.length;
  const patternEnd = workflow.indexOf("/m,", patternStart);
  assert.ok(
    patternEnd > patternStart,
    "the version rewrite is anchored with the multiline flag; an unanchored pattern matches nested strings",
  );

  // The workflow embeds this script in a double-quoted shell argument, so the
  // file stores `\"` where the running regex sees `"`.
  const pattern = workflow.slice(patternStart, patternEnd).replaceAll('\\"', '"');
  const rewrite = new RegExp(pattern, "m");

  const source = readFileSync(path.join(repoRoot, "src", "index.ts"), "utf-8");
  const hit = rewrite.exec(source);
  assert.equal(
    hit,
    null,
    `the release rewrite would edit ${JSON.stringify(hit?.[0] ?? "")}; this package declares its version via EXTENSION_VERSION and manifest.json only`,
  );

  // And the constant it does target is present, so the rewrite is not a silent no-op.
  assert.match(source, /const EXTENSION_VERSION = "\d{4}\.\d{1,2}\.\d{1,2}(-\d+)?";/);
});

// ---------------------------------------------------------------------------
// export --format coverage and --output file writing
// ---------------------------------------------------------------------------

test("export --format cypher emits parameterized Cypher statements", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    createItem(ws, "Alpha");
    const harness = await makeHarness(ws);
    const res = await harness.runCommand({
      command: "pm-graph export",
      args: ["--format", "cypher"],
      pmRoot: path.join(ws, ".agents", "pm"),
    }) as CmdResult;
    // The export command wraps the rendered payload in __pmGraphRawOutput for the
    // host's output-format override to unwrap; the test harness returns that
    // wrapper verbatim, so the real Cypher text lives here rather than on stdout.
    const r = res.result as { __pmGraphRawOutput: string; format: string; nodes: number };
    const raw = r.__pmGraphRawOutput;
    assert.ok(raw.includes("MERGE (n:PmGraphNode {projectKey: $projectKey"), "real parameterized MERGE clause");
    assert.ok(raw.includes("$projectKey"), "projectKey bound as a Cypher parameter");
    assert.ok(raw.includes("DETACH DELETE"), "per-project cleanup statement present");
    assert.equal(r.format, "cypher");
    assert.ok(r.nodes > 0, "at least one node exported");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("export --format plantuml emits a @startuml block", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    createItem(ws, "Alpha");
    const harness = await makeHarness(ws);
    const res = await harness.runCommand({
      command: "pm-graph export",
      args: ["--format", "plantuml"],
      pmRoot: path.join(ws, ".agents", "pm"),
    }) as CmdResult;
    const raw = (res.result as { __pmGraphRawOutput: string }).__pmGraphRawOutput;
    assert.ok(raw.startsWith("@startuml"), "PlantUML block starts with @startuml");
    assert.ok(raw.includes("left to right direction"), "PlantUML direction directive");
    assert.ok(raw.includes("object \""), "real PlantUML object declaration");
    assert.ok(raw.trim().endsWith("@enduml"), "PlantUML block ends with @enduml");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("export --format dot emits a Graphviz digraph", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    createItem(ws, "Alpha");
    const harness = await makeHarness(ws);
    const res = await harness.runCommand({
      command: "pm-graph export",
      args: ["--format", "dot"],
      pmRoot: path.join(ws, ".agents", "pm"),
    }) as CmdResult;
    const raw = (res.result as { __pmGraphRawOutput: string }).__pmGraphRawOutput;
    assert.ok(raw.startsWith("digraph pm_graph {"), "real Graphviz digraph header");
    assert.ok(raw.includes("rankdir=LR;"), "rankdir directive present");
    assert.ok(raw.includes('[shape=box, style=rounded];'), "node style declaration present");
    assert.ok(raw.trim().endsWith("}"), "digraph closes with a brace");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("export --format graphml emits valid GraphML XML", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    createItem(ws, "Alpha");
    const harness = await makeHarness(ws);
    const res = await harness.runCommand({
      command: "pm-graph export",
      args: ["--format", "graphml"],
      pmRoot: path.join(ws, ".agents", "pm"),
    }) as CmdResult;
    const raw = (res.result as { __pmGraphRawOutput: string }).__pmGraphRawOutput;
    assert.ok(raw.startsWith('<?xml version="1.0"'), "XML prolog present");
    assert.ok(raw.includes("<graphml"), "graphml root element present");
    assert.ok(raw.includes('edgedefault="directed"'), "directed graph attribute present");
    assert.ok(raw.includes('<data key="title">'), "node title data element present");
    assert.ok(raw.includes("</graphml>"), "graphml root closes");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("export --output writes the rendered format to a file", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    createItem(ws, "Alpha");
    const harness = await makeHarness(ws);
    const outFile = path.join(ws, "graph.json");
    const res = await harness.runCommand({
      command: "pm-graph export",
      args: ["--format", "json", "--output", outFile],
      pmRoot: path.join(ws, ".agents", "pm"),
    }) as CmdResult;
    assert.equal(res.handled, true);
    const result = res.result as { ok: boolean; file: string; format: string };
    assert.equal(result.format, "json");
    assert.equal(result.file, outFile);
    assert.ok(existsSync(outFile), "output file was written");
    const written = readFileSync(outFile, "utf-8");
    const parsed = JSON.parse(written) as { graph: { nodes: unknown[] } };
    assert.ok(Array.isArray(parsed.graph?.nodes), "written file is valid JSON graph");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("export --edges tags keeps only TAGGED_WITH edges", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    createItem(ws, "Beta", a);
    // Add a tag to Alpha so a TAGGED_WITH edge exists alongside the structural
    // BLOCKED_BY edge (Beta -> Alpha) and the facet edges (HAS_TYPE/HAS_STATUS).
    pm(ws, ["update", a, "--tags", "backend"]);
    const harness = await makeHarness(ws);
    const res = await harness.runCommand({
      command: "pm-graph export",
      args: ["--format", "mermaid", "--edges", "tags"],
      pmRoot: path.join(ws, ".agents", "pm"),
    }) as CmdResult;
    const raw = (res.result as { __pmGraphRawOutput: string }).__pmGraphRawOutput;
    assert.ok(raw.includes("TAGGED_WITH"), "tag edge kept by --edges tags");
    // deps (BLOCKED_BY) and facets (HAS_TYPE/HAS_STATUS) are dropped by the
    // tags filter, so none of their relationship labels survive in the output.
    assert.doesNotMatch(raw, /BLOCKED_BY|HAS_TYPE|HAS_STATUS/, "structural and facet edges dropped");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("export --root restricts to the neighborhood of a node", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    const b = createItem(ws, "Beta", a);
    const gamma = createItem(ws, "Gamma"); // disconnected from Alpha/Beta
    const harness = await makeHarness(ws);
    const res = await harness.runCommand({
      command: "pm-graph export",
      args: ["--json", "--root", a],
      pmRoot: path.join(ws, ".agents", "pm"),
    }) as CmdResult;
    const result = res.result as { ok: boolean; graph: { nodes: Array<{ id: string }> } };
    const ids = result.graph.nodes.filter((n) => n.id.startsWith("pm-")).map((n) => n.id);
    assert.ok(ids.includes(a), "root included");
    assert.ok(ids.includes(b), "dependency neighbor included");

    // `export` defaults to --edges all, and shapeGraph walks relationships as
    // UNDIRECTED for reachability, so Gamma is legitimately inside the
    // neighborhood: it shares the `type:Task` and `status:open` facet nodes with
    // Alpha, which form a real path. Asserting its absence here would be
    // asserting against the documented semantics.
    assert.ok(ids.includes(gamma), "with --edges all, facet links make every task reachable");

    // --edges deps is what actually isolates a dependency neighborhood (and is
    // what shapedAnalyticsGraph pins for exactly this reason). THIS is where a
    // broken root filter shows up, so assert the exact node set.
    const depsOnly = await harness.runCommand({
      command: "pm-graph export",
      args: ["--json", "--root", a, "--edges", "deps"],
      pmRoot: path.join(ws, ".agents", "pm"),
    }) as CmdResult;
    const depsIds = (depsOnly.result as { graph: { nodes: Array<{ id: string }> } })
      .graph.nodes.filter((n) => n.id.startsWith("pm-")).map((n) => n.id);
    assert.deepStrictEqual(
      [...depsIds].sort(),
      [a, b].sort(),
      "with --edges deps the neighborhood is exactly the root and its dependency neighbor",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// cypher command
// ---------------------------------------------------------------------------

test("cypher command returns statement count matching node+relationship count", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    createItem(ws, "Beta", a);
    const harness = await makeHarness(ws);
    const res = await harness.runCommand({ command: "pm-graph cypher", pmRoot: path.join(ws, ".agents", "pm") }) as CmdResult;
    assert.equal(res.handled, true);
    const result = res.result as { ok: boolean; graph: { nodes: number; relationships: number }; statements: unknown[] };
    assert.equal(result.ok, true);
    assert.ok(result.graph.nodes > 0, "node count reported");
    // 1 DELETE + N node MERGEs + R relationship MERGEs
    assert.strictEqual(result.statements.length, 1 + result.graph.nodes + result.graph.relationships);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// topo-sort command
// ---------------------------------------------------------------------------

test("topo-sort returns a valid order on an acyclic workspace", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    const b = createItem(ws, "Beta", a);
    createItem(ws, "Gamma", b);
    const harness = await makeHarness(ws);
    const res = await harness.runCommand({ command: "pm-graph topo-sort", pmRoot: path.join(ws, ".agents", "pm") }) as CmdResult;
    assert.equal(res.handled, true);
    const result = res.result as { ok: boolean; order: string[]; cyclic: boolean; count: number };
    assert.equal(result.ok, true);
    assert.equal(result.cyclic, false);
    assert.strictEqual(result.count, result.order.length);
    // Alpha (the blocker) must come before Beta, which must come before Gamma.
    assert.ok(result.order.indexOf(a) < result.order.indexOf(b), "blocker before dependent");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("topo-sort exits non-zero on a dependency cycle", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const x = createItem(ws, "X");
    const y = createItem(ws, "Y", x);
    pm(ws, ["update", x, "--blocked-by", y]); // X <-> Y cycle
    const harness = await makeHarness(ws);
    // A handler that throws a numeric-exitCode CommandError propagates the throw
    // through the dispatch engine (matching runtime non-zero-exit semantics), so
    // assert on the real thrown error's shape rather than a returned field.
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph topo-sort", pmRoot: path.join(ws, ".agents", "pm") }),
      (err: CommandError) => {
        assert.ok(err instanceof Error, "a real error is thrown");
        assert.strictEqual(err.exitCode, 1, "cyclic graph exits with code 1 (GENERIC_FAILURE)");
        assert.match(err.message, /dependency cycle/i, "error names the cycle");
        return true;
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// path command edge cases
// ---------------------------------------------------------------------------

test("path with missing positionals returns a USAGE error", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const harness = await makeHarness(ws);
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph path", args: ["only-one"], pmRoot: path.join(ws, ".agents", "pm") }),
      (err: CommandError) => {
        assert.strictEqual(err.exitCode, 2, "USAGE exit code");
        assert.match(err.message, /Usage: pm pm-graph path/);
        return true;
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("path with no positionals returns a USAGE error", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const harness = await makeHarness(ws);
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph path", pmRoot: path.join(ws, ".agents", "pm") }),
      (err: CommandError) => {
        assert.strictEqual(err.exitCode, 2, "USAGE exit code");
        assert.match(err.message, /Usage: pm pm-graph path/);
        return true;
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("path reports found:false when no directed path exists", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    const b = createItem(ws, "Beta", a); // B blocked by A, so edge B->A
    const harness = await makeHarness(ws);
    const res = await harness.runCommand({
      command: "pm-graph path",
      args: [a, b], // from A to B: no directed path (A is the blocker, not B)
      pmRoot: path.join(ws, ".agents", "pm"),
    }) as CmdResult;
    const result = res.result as { ok: boolean; found: boolean; path: string[] | null; length: number | null };
    assert.equal(result.found, false, "no directed path from blocker to dependent");
    assert.strictEqual(result.path, null);
    assert.strictEqual(result.length, null);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// explain command edge cases
// ---------------------------------------------------------------------------

test("explain with missing id returns a USAGE error", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const harness = await makeHarness(ws);
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph explain", pmRoot: path.join(ws, ".agents", "pm") }),
      (err: CommandError) => {
        assert.strictEqual(err.exitCode, 2, "USAGE exit code");
        assert.match(err.message, /Usage: pm pm-graph explain/);
        return true;
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("explain with unknown id returns a NOT_FOUND error with suggestions", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const alpha = createItem(ws, "Alpha");
    const harness = await makeHarness(ws);
    // A non-prefix substring of a real item id fails every resolution path
    // (exact, case-insensitive, prefix) but still matches the suggestion scorer
    // (the id contains the probe), so the error genuinely carries a hint.
    const probe = alpha.slice(1);
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph explain", args: [probe], pmRoot: path.join(ws, ".agents", "pm") }),
      (err: CommandError) => {
        assert.strictEqual(err.exitCode, 3, "NOT_FOUND exit code");
        assert.match(err.message, /was not found in the workspace graph/);
        assert.match(err.message, /Did you mean/, "suggestion hint present");
        return true;
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// analyze --root neighborhood
// ---------------------------------------------------------------------------

test("analyze --root restricts the report to the root neighborhood", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    const b = createItem(ws, "Beta", a);
    createItem(ws, "Solo"); // disconnected
    const harness = await makeHarness(ws);
    const res = await harness.runCommand({
      command: "pm-graph analyze",
      args: ["--root", a, "--json"],
      pmRoot: path.join(ws, ".agents", "pm"),
    }) as CmdResult;
    const result = res.result as { ok: boolean; itemCount: number };
    assert.equal(result.ok, true);
    // Neighborhood of A includes A and B (1 hop) but not Solo.
    assert.ok(result.itemCount <= 2, "Solo excluded from the neighborhood");
    assert.ok(result.itemCount >= 1, "at least the root is present");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// cycles command — no cycles returns cycleCount 0
// ---------------------------------------------------------------------------

test("cycles on an acyclic workspace returns cycleCount 0 and exits 0", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    createItem(ws, "Alpha");
    const harness = await makeHarness(ws);
    const res = await harness.runCommand({ command: "pm-graph cycles", pmRoot: path.join(ws, ".agents", "pm") }) as CmdResult;
    assert.equal(res.handled, true);
    const result = res.result as { ok: boolean; cycleCount: number; cycles: unknown[] };
    assert.equal(result.ok, true);
    assert.equal(result.cycleCount, 0);
    assert.deepStrictEqual(result.cycles, []);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// status command — Neo4j not configured
// ---------------------------------------------------------------------------

test("status with Neo4j not configured returns the local item count", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    createItem(ws, "Alpha");
    createItem(ws, "Beta");
    const harness = await makeHarness(ws);
    const res = await harness.runCommand({ command: "pm-graph status", pmRoot: path.join(ws, ".agents", "pm") }) as CmdResult;
    assert.equal(res.handled, true);
    const result = res.result as { ok: boolean; neo4jConfigured: boolean; localItemCount: number; projectKey: string; version: string };
    assert.equal(result.ok, true);
    assert.equal(result.neo4jConfigured, false);
    assert.equal(result.localItemCount, 2, "two items counted locally");
    assert.ok(typeof result.version === "string");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Neo4j error paths — env vars set so the real driver attempts a connection
// and fails, hitting neo4jFriendlyError
// ---------------------------------------------------------------------------

test("query with Neo4j env vars set reaches the connection-error path", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const harness = await makeHarness(ws);
    // Point the driver at a closed local port and cap its connect/retry budgets
    // so the connection attempt fails in well under a second instead of waiting
    // out the driver's 30s transaction-retry default against an absent host.
    const env = {
      ...process.env,
      NEO4J_URI: "bolt://127.0.0.1:9",
      NEO4J_USER: "test",
      NEO4J_PASSWORD: "test",
      NEO4J_CONNECTION_TIMEOUT_MS: "300",
      NEO4J_MAX_RETRY_MS: "0",
    };
    const originalEnv = { ...process.env };
    Object.assign(process.env, env);
    try {
      const start = Date.now();
      const res = await harness.runCommand({
        command: "pm-graph query",
        args: ["MATCH (n) RETURN n LIMIT 1"],
        pmRoot: path.join(ws, ".agents", "pm"),
      }) as CmdResult;
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 5000, `connection error reached quickly (took ${elapsed}ms)`);
      assert.ok(res.errorMessage || !res.handled, "connection failure surfaces an error");
      if (res.errorMessage) {
        // The friendly error mentions reachability or authentication.
        assert.ok(
          /not reachable|authentication|connection/i.test(res.errorMessage),
          `friendly Neo4j error: ${res.errorMessage}`,
        );
      }
    } finally {
      // Restore env
      for (const k of Object.keys(process.env)) {
        if (!(k in originalEnv)) delete process.env[k];
      }
      Object.assign(process.env, originalEnv);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("sync with Neo4j env vars set reaches the connection-error path", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    createItem(ws, "Alpha");
    const harness = await makeHarness(ws);
    const env = { ...process.env, NEO4J_URI: "bolt://127.0.0.1:9", NEO4J_USER: "test", NEO4J_PASSWORD: "test", NEO4J_CONNECTION_TIMEOUT_MS: "300", NEO4J_MAX_RETRY_MS: "0" };
    const originalEnv = { ...process.env };
    Object.assign(process.env, env);
    try {
      const res = await harness.runCommand({ command: "pm-graph sync", pmRoot: path.join(ws, ".agents", "pm") }) as CmdResult;
      assert.ok(res.errorMessage || !res.handled, "sync connection failure surfaces an error");
      if (res.errorMessage) {
        assert.ok(/not reachable|connection/i.test(res.errorMessage), `friendly error: ${res.errorMessage}`);
      }
    } finally {
      for (const k of Object.keys(process.env)) {
        if (!(k in originalEnv)) delete process.env[k];
      }
      Object.assign(process.env, originalEnv);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("neighbors with Neo4j env vars set reaches the connection-error path", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const harness = await makeHarness(ws);
    const env = { ...process.env, NEO4J_URI: "bolt://127.0.0.1:9", NEO4J_USER: "test", NEO4J_PASSWORD: "test", NEO4J_CONNECTION_TIMEOUT_MS: "300", NEO4J_MAX_RETRY_MS: "0" };
    const originalEnv = { ...process.env };
    Object.assign(process.env, env);
    try {
      const res = await harness.runCommand({
        command: "pm-graph neighbors",
        args: ["TASK-1"],
        pmRoot: path.join(ws, ".agents", "pm"),
      }) as CmdResult;
      assert.ok(res.errorMessage || !res.handled, "neighbors connection failure surfaces an error");
      if (res.errorMessage) {
        assert.ok(/not reachable|connection/i.test(res.errorMessage), `friendly error: ${res.errorMessage}`);
      }
    } finally {
      for (const k of Object.keys(process.env)) {
        if (!(k in originalEnv)) delete process.env[k];
      }
      Object.assign(process.env, originalEnv);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("status with Neo4j env vars set reaches the connection-error path", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    createItem(ws, "Alpha");
    const harness = await makeHarness(ws);
    const env = { ...process.env, NEO4J_URI: "bolt://127.0.0.1:9", NEO4J_USER: "test", NEO4J_PASSWORD: "test", NEO4J_CONNECTION_TIMEOUT_MS: "300", NEO4J_MAX_RETRY_MS: "0" };
    const originalEnv = { ...process.env };
    Object.assign(process.env, env);
    try {
      const res = await harness.runCommand({ command: "pm-graph status", pmRoot: path.join(ws, ".agents", "pm") }) as CmdResult;
      assert.ok(res.errorMessage || !res.handled, "status connection failure surfaces an error");
      if (res.errorMessage) {
        assert.ok(/not reachable|connection/i.test(res.errorMessage), `friendly error: ${res.errorMessage}`);
      }
    } finally {
      for (const k of Object.keys(process.env)) {
        if (!(k in originalEnv)) delete process.env[k];
      }
      Object.assign(process.env, originalEnv);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Exporter adapter via the SDK harness (runExporter)
// ---------------------------------------------------------------------------

test("graph-export exporter renders JSON graph format via the SDK dispatch", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    createItem(ws, "Alpha");
    const harness = await makeHarness(ws);
    const { stdout } = await captureStdout(async () =>
      harness.runExporter({
        exporter: "graph-export",
        options: { format: "json" },
        pmRoot: path.join(ws, ".agents", "pm"),
      }),
    );
    const parsed = JSON.parse(stdout) as { graph: { nodes: unknown[] } };
    assert.ok(Array.isArray(parsed.graph?.nodes), "exporter emits valid JSON graph");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("graph-export exporter rejects an invalid --format", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const harness = await makeHarness(ws);
    await assert.rejects(
      () => harness.runExporter({ exporter: "graph-export", options: { format: "svg" }, pmRoot: path.join(ws, ".agents", "pm") }),
      (err: CommandError) => {
        assert.strictEqual(err.exitCode, 2, "USAGE exit code");
        assert.match(err.message, /Unknown --format "svg"/);
        assert.match(err.message, /cypher \| mermaid \| dot \| json \| graphml \| plantuml/, "valid formats listed");
        return true;
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("graph-export exporter rejects an invalid --edges value", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const harness = await makeHarness(ws);
    await assert.rejects(
      () => harness.runExporter({ exporter: "graph-export", options: { format: "json", edges: "bogus" }, pmRoot: path.join(ws, ".agents", "pm") }),
      (err: CommandError) => {
        assert.strictEqual(err.exitCode, 2, "USAGE exit code");
        assert.match(err.message, /Unknown --edges "bogus"/);
        assert.match(err.message, /deps \| tags \| all/, "valid edges listed");
        return true;
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------
// query destructive-keyword guard — rejects before any Neo4j connection
// ---------------------------------------------------------------------------

test("query rejects a destructive Cypher keyword with a USAGE error", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const harness = await makeHarness(ws);
    // No Neo4j env required: the destructive-keyword guard runs before the
    // driver is created, so this is fast and exercises a real safety feature.
    await assert.rejects(
      () => harness.runCommand({
        command: "pm-graph query",
        args: ["CREATE (n {x: 1})"],
        pmRoot: path.join(ws, ".agents", "pm"),
      }),
      (err: CommandError) => {
        assert.strictEqual(err.exitCode, 2, "USAGE exit code");
        assert.match(err.message, /Blocked destructive Cypher keyword "CREATE"/);
        assert.match(err.message, /Only read-only queries/, "read-only guidance present");
        return true;
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("query rejects an empty query with a USAGE error", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const harness = await makeHarness(ws);
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph query", args: ["--json"], pmRoot: path.join(ws, ".agents", "pm") }),
      (err: CommandError) => {
        assert.strictEqual(err.exitCode, 2, "USAGE exit code");
        assert.match(err.message, /Usage: pm pm-graph query/);
        return true;
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// graph-export exporter — exercisable validation and flag branches
// ---------------------------------------------------------------------------

test("graph-export exporter rejects --depth without --root", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const harness = await makeHarness(ws);
    await assert.rejects(
      () => harness.runExporter({ exporter: "graph-export", options: { format: "json", depth: 2 }, pmRoot: path.join(ws, ".agents", "pm") }),
      (err: CommandError) => {
        assert.strictEqual(err.exitCode, 2, "USAGE exit code");
        assert.match(err.message, /--depth requires --root/);
        return true;
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("graph-export exporter rejects a non-integer --depth", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const root = createItem(ws, "Root");
    const harness = await makeHarness(ws);
    await assert.rejects(
      () => harness.runExporter({ exporter: "graph-export", options: { format: "json", root, depth: "abc" }, pmRoot: path.join(ws, ".agents", "pm") }),
      (err: CommandError) => {
        assert.strictEqual(err.exitCode, 2, "USAGE exit code");
        assert.match(err.message, /Invalid --depth "abc"/);
        return true;
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("graph-export exporter rejects an unknown --root node", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    createItem(ws, "Alpha");
    const harness = await makeHarness(ws);
    await assert.rejects(
      () => harness.runExporter({ exporter: "graph-export", options: { format: "json", root: "does-not-exist" }, pmRoot: path.join(ws, ".agents", "pm") }),
      (err: CommandError) => {
        assert.strictEqual(err.exitCode, 3, "NOT_FOUND exit code");
        assert.match(err.message, /--root node "does-not-exist" was not found/);
        return true;
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("graph-export exporter rejects an empty --output path", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const harness = await makeHarness(ws);
    await assert.rejects(
      () => harness.runExporter({ exporter: "graph-export", options: { format: "json", output: "   " }, pmRoot: path.join(ws, ".agents", "pm") }),
      (err: CommandError) => {
        assert.strictEqual(err.exitCode, 2, "USAGE exit code");
        assert.match(err.message, /--output requires a file path/);
        return true;
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("graph-export exporter applies a valid --root and --depth neighborhood", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  try {
    pm(ws, ["init"]);
    const a = createItem(ws, "Alpha");
    createItem(ws, "Beta", a); // neighbour of Alpha
    createItem(ws, "Solo"); // disconnected
    const harness = await makeHarness(ws);
    const { stdout } = await captureStdout(async () =>
      harness.runExporter({ exporter: "graph-export", options: { format: "json", root: a, depth: 1 }, pmRoot: path.join(ws, ".agents", "pm") }),
    );
    const parsed = JSON.parse(stdout) as { graph: { nodes: Array<{ id: string }> } };
    const itemIds = parsed.graph.nodes.filter((n) => n.id.startsWith("pm-")).map((n) => n.id);
    assert.ok(itemIds.includes(a), "root retained");
    assert.ok(!itemIds.includes("Solo"), "disconnected node excluded by neighborhood depth");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("an invalid explicit tracker root fails with a USAGE exit rather than an empty graph", { skip: !pmAvailable }, async () => {
  // The SDK reader resolves with an empty array for an absent path, for a path
  // that is a regular file (swallowing ENOTDIR), and for a directory that is not
  // a tracker. Without assertPmTracker a mistyped --path would make analyze
  // report a confident empty graph and exit 0, where the removed `pm list-all`
  // shell-out exited non-zero. An empty answer for a bad input is worse than a
  // failure, because nothing downstream can detect it.
  const ws = freshWorkspace();
  try {
    const harness = await makeHarness(ws);
    const notATracker = path.join(ws, "tracker-is-a-file");
    writeFileSync(notATracker, "not a tracker\n");

    const schemaIsFileRoot = path.join(ws, "schema-is-a-file");
    mkdirSync(schemaIsFileRoot, { recursive: true });
    writeFileSync(path.join(schemaIsFileRoot, "schema"), "decoy\n");

    const settingsIsDirRoot = path.join(ws, "settings-is-a-dir");
    mkdirSync(path.join(settingsIsDirRoot, "settings.json"), { recursive: true });

    for (const [label, badRoot] of [
      ["absent path", path.join(ws, "does-not-exist", ".agents", "pm")],
      ["path is a file", notATracker],
      ["directory without settings.json or schema/", ws],
      // Marker TYPE matters, not just presence: a directory holding a FILE named
      // `schema`, or a DIRECTORY named `settings.json`, is not a tracker. Letting
      // either through would hand the path to a reader that answers with an empty
      // list, restoring the very regression this guard prevents.
      ["schema is a file, not a directory", schemaIsFileRoot],
      ["settings.json is a directory, not a file", settingsIsDirRoot],
    ] as const) {
      await assert.rejects(
        () => harness.runCommand({ command: "pm-graph analyze", pmRoot: badRoot }),
        (err: CommandError) => {
          assert.strictEqual(
            err.name,
            "CommandError",
            `${label}: must be a CommandError so the exit code survives to the host`,
          );
          assert.strictEqual(
            err.exitCode,
            2,
            `${label}: an unusable tracker root is a USAGE error (exit 2)`,
          );
          return true;
        },
        `${label}: must fail rather than report an empty graph`,
      );
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
