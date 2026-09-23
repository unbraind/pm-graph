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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  type CmdResult,
  type CommandError,
  NEO4J_FAIL_ENV,
  applyEnv,
  captureStdout,
  createChain,
  createItem,
  expectCommandError,
  expectCommandErrorMulti,
  expectExporterReject,
  freshWorkspace,
  makeHarness,
  pm,
  pmAvailable,
  restoreEnv,
  runExportRaw,
  withCommandWorkspace,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// ping command
// ---------------------------------------------------------------------------

test("ping returns extension version and Neo4j status (not configured)", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ harness, pmRoot }) => {
    const res = await harness.runCommand({ command: "pm-graph ping", pmRoot }) as CmdResult;
    assert.equal(res.handled, true);
    const result = res.result as { ok: boolean; version: string; neo4jConfigured: boolean; source: string };
    assert.equal(result.ok, true);
    assert.equal(result.source, "pm-graph");
    assert.equal(result.neo4jConfigured, false, "Neo4j not configured by default");
    assert.ok(typeof result.version === "string", "version present");
  });
});

test("ping --help returns usage text", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ harness, pmRoot }) => {
    const res = await harness.runCommand({ command: "pm-graph ping", args: ["--help"], pmRoot }) as CmdResult;
    assert.equal(res.handled, true);
    const result = res.result as { usage: string; description: string };
    assert.ok(typeof result.usage === "string");
    assert.ok(result.usage.includes("pm-graph ping"));
  });
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
  await withCommandWorkspace("pmg-cmd-", async ({ harness, pmRoot }) => {
    const res = await harness.runCommand({ command: "pm-graph status", args: ["--help"], pmRoot }) as CmdResult;
    assert.equal(res.handled, true);
    const result = res.result as { output: Record<string, string> };
    assert.ok(result.output, "status help exposes an output map");

    // Deliberately broader than this package's CalVer scheme. The rewrite writes
    // whatever `package.json` carries, so pinning the guard to `2026.7.28`-shaped
    // strings would stop catching the regression the moment the versioning scheme
    // changed — and a literal `1.2.3` is no more a field description than a
    // literal `2026.7.28` is.
    const versionLike = /^v?\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
    for (const [field, text] of Object.entries(result.output)) {
      assert.equal(typeof text, "string", `${field} is documented with a string`);
      assert.ok(text.length > 0, `${field} is documented`);
      assert.ok(
        !versionLike.test(text.trim()),
        `${field} is documented with a description, not the literal value "${text}"`,
      );
    }
    assert.match(result.output.version, /version/i, "the version field describes itself");
  });
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

  // Read the candidate list out of the workflow too, rather than hardcoding a
  // parallel copy. The workflow rewrites every file in its own list, so a guard
  // that checks a fixed subset stops covering the job the moment that list grows
  // — adding a root `index.ts` would reintroduce an unintended rewrite target
  // with the test still green.
  // Searched backwards from the rewrite: the `source.replace` call sits *inside*
  // the loop that declares the candidates, so scanning forward finds nothing.
  const loopMarker = "for(const file of [";
  const loopStart = workflow.lastIndexOf(loopMarker, start);
  assert.ok(loopStart >= 0, "release.yml still iterates a source-file candidate list");
  const loopEnd = workflow.indexOf("]", loopStart);
  const candidates = workflow
    .slice(loopStart + loopMarker.length, loopEnd)
    .split(",")
    .map((entry) => entry.trim().replace(/^'|'$/g, ""))
    .filter((entry) => entry.endsWith(".ts"));
  assert.ok(candidates.length > 0, "the candidate list was parsed, not silently emptied");

  let checked = 0;
  for (const candidate of candidates) {
    const candidatePath = path.join(repoRoot, candidate);
    if (!existsSync(candidatePath)) continue;
    checked += 1;
    const source = readFileSync(candidatePath, "utf-8");
    const hit = rewrite.exec(source);
    assert.equal(
      hit,
      null,
      `the release rewrite would edit ${JSON.stringify(hit?.[0] ?? "")} in ${candidate}; this package declares its version via EXTENSION_VERSION and manifest.json only`,
    );
  }
  assert.ok(checked > 0, "at least one candidate exists, so the assertions above ran");

  // And the constant it does target is present, so the rewrite is not a silent no-op.
  assert.match(
    readFileSync(path.join(repoRoot, "src", "index.ts"), "utf-8"),
    /const EXTENSION_VERSION = "\d{4}\.\d{1,2}\.\d{1,2}(-\d+)?";/,
  );
});

// ---------------------------------------------------------------------------
// export --format coverage and --output file writing
// ---------------------------------------------------------------------------

test("export --format cypher emits parameterized Cypher statements", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ ws, harness, pmRoot }) => {
    createItem(ws, "Alpha");
    const raw = await runExportRaw(harness, pmRoot, "cypher");
    assert.ok(raw.includes("MERGE (n:PmGraphNode {projectKey: $projectKey"), "real parameterized MERGE clause");
    assert.ok(raw.includes("$projectKey"), "projectKey bound as a Cypher parameter");
    assert.ok(raw.includes("DETACH DELETE"), "per-project cleanup statement present");
  });
});

test("export --format plantuml emits a @startuml block", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ ws, harness, pmRoot }) => {
    createItem(ws, "Alpha");
    const raw = await runExportRaw(harness, pmRoot, "plantuml");
    assert.ok(raw.startsWith("@startuml"), "PlantUML block starts with @startuml");
    assert.ok(raw.includes("left to right direction"), "PlantUML direction directive");
    assert.ok(raw.includes("object \""), "real PlantUML object declaration");
    assert.ok(raw.trim().endsWith("@enduml"), "PlantUML block ends with @enduml");
  });
});

test("export --format dot emits a Graphviz digraph", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ ws, harness, pmRoot }) => {
    createItem(ws, "Alpha");
    const raw = await runExportRaw(harness, pmRoot, "dot");
    assert.ok(raw.startsWith("digraph pm_graph {"), "real Graphviz digraph header");
    assert.ok(raw.includes("rankdir=LR;"), "rankdir directive present");
    assert.ok(raw.includes('[shape=box, style=rounded];'), "node style declaration present");
    assert.ok(raw.trim().endsWith("}"), "digraph closes with a brace");
  });
});

test("export --format graphml emits valid GraphML XML", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ ws, harness, pmRoot }) => {
    createItem(ws, "Alpha");
    const raw = await runExportRaw(harness, pmRoot, "graphml");
    assert.ok(raw.startsWith('<?xml version="1.0"'), "XML prolog present");
    assert.ok(raw.includes("<graphml"), "graphml root element present");
    assert.ok(raw.includes('edgedefault="directed"'), "directed graph attribute present");
    assert.ok(raw.includes('<data key="title">'), "node title data element present");
    assert.ok(raw.includes("</graphml>"), "graphml root closes");
  });
});

test("export --output writes the rendered format to a file", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ ws, harness, pmRoot }) => {
    createItem(ws, "Alpha");
    const outFile = path.join(ws, "graph.json");
    const res = await harness.runCommand({
      command: "pm-graph export",
      args: ["--format", "json", "--output", outFile],
      pmRoot,
    }) as CmdResult;
    assert.equal(res.handled, true);
    const result = res.result as { ok: boolean; file: string; format: string };
    assert.equal(result.format, "json");
    assert.equal(result.file, outFile);
    assert.ok(existsSync(outFile), "output file was written");
    const written = readFileSync(outFile, "utf-8");
    const parsed = JSON.parse(written) as { graph: { nodes: unknown[] } };
    assert.ok(Array.isArray(parsed.graph?.nodes), "written file is valid JSON graph");
  });
});

test("export --edges tags keeps only TAGGED_WITH edges", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ ws, harness, pmRoot }) => {
    const a = createItem(ws, "Alpha");
    createItem(ws, "Beta", a);
    // Add a tag to Alpha so a TAGGED_WITH edge exists alongside the structural
    // BLOCKED_BY edge (Beta -> Alpha) and the facet edges (HAS_TYPE/HAS_STATUS).
    pm(ws, ["update", a, "--tags", "backend"]);
    const res = await harness.runCommand({
      command: "pm-graph export",
      args: ["--format", "mermaid", "--edges", "tags"],
      pmRoot,
    }) as CmdResult;
    const raw = (res.result as { __pmGraphRawOutput: string }).__pmGraphRawOutput;
    assert.ok(raw.includes("TAGGED_WITH"), "tag edge kept by --edges tags");
    // deps (BLOCKED_BY) and facets (HAS_TYPE/HAS_STATUS) are dropped by the
    // tags filter, so none of their relationship labels survive in the output.
    assert.doesNotMatch(raw, /BLOCKED_BY|HAS_TYPE|HAS_STATUS/, "structural and facet edges dropped");
  });
});

test("export --root restricts to the neighborhood of a node", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ ws, harness, pmRoot }) => {
    const a = createItem(ws, "Alpha");
    const b = createItem(ws, "Beta", a);
    const gamma = createItem(ws, "Gamma"); // disconnected from Alpha/Beta
    const res = await harness.runCommand({
      command: "pm-graph export",
      args: ["--json", "--root", a],
      pmRoot,
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
      pmRoot,
    }) as CmdResult;
    const depsIds = (depsOnly.result as { graph: { nodes: Array<{ id: string }> } })
      .graph.nodes.filter((n) => n.id.startsWith("pm-")).map((n) => n.id);
    assert.deepStrictEqual(
      [...depsIds].sort(),
      [a, b].sort(),
      "with --edges deps the neighborhood is exactly the root and its dependency neighbor",
    );
  });
});

// ---------------------------------------------------------------------------
// cypher command
// ---------------------------------------------------------------------------

test("cypher command returns statement count matching node+relationship count", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ ws, harness, pmRoot }) => {
    const a = createItem(ws, "Alpha");
    createItem(ws, "Beta", a);
    const res = await harness.runCommand({ command: "pm-graph cypher", pmRoot }) as CmdResult;
    assert.equal(res.handled, true);
    const result = res.result as { ok: boolean; graph: { nodes: number; relationships: number }; statements: unknown[] };
    assert.equal(result.ok, true);
    assert.ok(result.graph.nodes > 0, "node count reported");
    // 1 DELETE + N node MERGEs + R relationship MERGEs
    assert.strictEqual(result.statements.length, 1 + result.graph.nodes + result.graph.relationships);
  });
});

// ---------------------------------------------------------------------------
// topo-sort command
// ---------------------------------------------------------------------------

test("topo-sort returns a valid order on an acyclic workspace", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ ws, harness, pmRoot }) => {
    const { a, b, c } = createChain(ws);
    const res = await harness.runCommand({ command: "pm-graph topo-sort", pmRoot }) as CmdResult;
    assert.ok(res.handled);
    const result = res.result as { ok: boolean; order: string[]; cyclic: boolean; count: number };
    assert.equal(result.ok, true);
    assert.equal(result.cyclic, false);
    assert.strictEqual(result.count, result.order.length);
    // Alpha (the blocker) must come before Beta, which must come before Gamma.
    assert.ok(result.order.indexOf(a) < result.order.indexOf(b), "blocker before dependent");
    assert.ok(result.order.indexOf(b) < result.order.indexOf(c), "dependent before its own dependent");
  });
});

test("topo-sort exits non-zero on a dependency cycle", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ ws, harness, pmRoot }) => {
    const x = createItem(ws, "X");
    const y = createItem(ws, "Y", x);
    pm(ws, ["update", x, "--blocked-by", y]); // X <-> Y cycle
    // A handler that throws a numeric-exitCode CommandError propagates the throw
    // through the dispatch engine (matching runtime non-zero-exit semantics), so
    // assert on the real thrown error's shape rather than a returned field.
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph topo-sort", pmRoot }),
      (err: CommandError) => {
        assert.ok(err instanceof Error, "a real error is thrown");
        assert.strictEqual(err.exitCode, 1, "cyclic graph exits with code 1 (GENERIC_FAILURE)");
        assert.match(err.message, /dependency cycle/i, "error names the cycle");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// path command edge cases
// ---------------------------------------------------------------------------

test("path with missing positionals returns a USAGE error", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ harness, pmRoot }) => {
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph path", args: ["only-one"], pmRoot }),
      expectCommandError(2, /Usage: pm pm-graph path/),
    );
  });
});

test("path with no positionals returns a USAGE error", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ harness, pmRoot }) => {
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph path", pmRoot }),
      expectCommandError(2, /Usage: pm pm-graph path/),
    );
  });
});

test("path reports found:false when no directed path exists", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ ws, harness, pmRoot }) => {
    const from = createItem(ws, "Alpha");
    const to = createItem(ws, "Beta", from); // B blocked by A, so edge B->A
    const res = await harness.runCommand({
      command: "pm-graph path",
      args: [from, to], // from A to B: no directed path (A is the blocker, not B)
      pmRoot,
    }) as CmdResult;
    const result = res.result as { ok: boolean; found: boolean; path: string[] | null; length: number | null };
    assert.equal(result.found, false, "no directed path from blocker to dependent");
    assert.strictEqual(result.path, null);
    assert.strictEqual(result.length, null);
  });
});

// ---------------------------------------------------------------------------
// explain command edge cases
// ---------------------------------------------------------------------------

test("explain with missing id returns a USAGE error", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ harness, pmRoot }) => {
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph explain", pmRoot }),
      expectCommandError(2, /Usage: pm pm-graph explain/),
    );
  });
});

test("explain with unknown id returns a NOT_FOUND error with suggestions", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ ws, harness, pmRoot }) => {
    const alpha = createItem(ws, "Alpha");
    // A non-prefix substring of a real item id fails every resolution path
    // (exact, case-insensitive, prefix) but still matches the suggestion scorer
    // (the id contains the probe), so the error genuinely carries a hint.
    const probe = alpha.slice(1);
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph explain", args: [probe], pmRoot }),
      (err: CommandError) => {
        assert.strictEqual(err.exitCode, 3, "NOT_FOUND exit code");
        assert.match(err.message, /was not found in the workspace graph/);
        assert.match(err.message, /Did you mean/, "suggestion hint present");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// analyze --root neighborhood
// ---------------------------------------------------------------------------

test("analyze --root restricts the report to the root neighborhood", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ ws, harness, pmRoot }) => {
    const root = createItem(ws, "Alpha");
    createItem(ws, "Beta", root);
    createItem(ws, "Solo"); // disconnected
    const res = await harness.runCommand({
      command: "pm-graph analyze",
      args: ["--root", root, "--json"],
      pmRoot,
    }) as CmdResult;
    const result = res.result as { ok: boolean; itemCount: number };
    assert.equal(result.ok, true);
    // Neighborhood of Alpha is exactly Alpha and Beta (1 hop); Solo is excluded.
    assert.strictEqual(result.itemCount, 2, "root plus its one-hop dependent, without Solo");
  });
});

// ---------------------------------------------------------------------------
// cycles command — no cycles returns cycleCount 0
// ---------------------------------------------------------------------------

test("cycles on an acyclic workspace returns cycleCount 0 and exits 0", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ ws, harness, pmRoot }) => {
    createItem(ws, "Alpha");
    const res = await harness.runCommand({ command: "pm-graph cycles", pmRoot }) as CmdResult;
    assert.equal(res.handled, true);
    const result = res.result as { ok: boolean; cycleCount: number; cycles: unknown[] };
    assert.equal(result.ok, true);
    assert.equal(result.cycleCount, 0);
    assert.deepStrictEqual(result.cycles, []);
  });
});

// ---------------------------------------------------------------------------
// status command — Neo4j not configured
// ---------------------------------------------------------------------------

test("status with Neo4j not configured returns the local item count", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ ws, harness, pmRoot }) => {
    createItem(ws, "Alpha");
    createItem(ws, "Beta");
    const res = await harness.runCommand({ command: "pm-graph status", pmRoot }) as CmdResult;
    assert.equal(res.handled, true);
    const result = res.result as { ok: boolean; neo4jConfigured: boolean; localItemCount: number; projectKey: string; version: string };
    assert.equal(result.ok, true);
    assert.equal(result.neo4jConfigured, false);
    assert.equal(result.localItemCount, 2, "two items counted locally");
    assert.ok(typeof result.version === "string");
  });
});

// ---------------------------------------------------------------------------
// Neo4j error paths — env vars set so the real driver attempts a connection
// and fails, hitting neo4jFriendlyError
// ---------------------------------------------------------------------------

test("query with Neo4j env vars set reaches the connection-error path", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ harness, pmRoot }) => {
    // Point the driver at a closed local port and cap its connect/retry budgets
    // so the connection attempt fails in well under a second instead of waiting
    // out the driver's 30s transaction-retry default against an absent host.
    const originalEnv = applyEnv(NEO4J_FAIL_ENV);
    try {
      const start = Date.now();
      const res = await harness.runCommand({
        command: "pm-graph query",
        args: ["MATCH (n) RETURN n LIMIT 1"],
        pmRoot,
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
      restoreEnv(originalEnv);
    }
  });
});

test("sync with Neo4j env vars set reaches the connection-error path", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ ws, harness, pmRoot }) => {
    createItem(ws, "Alpha");
    const originalEnv = applyEnv(NEO4J_FAIL_ENV);
    try {
      const res = await harness.runCommand({ command: "pm-graph sync", pmRoot }) as CmdResult;
      assert.ok(res.errorMessage || !res.handled, "sync connection failure surfaces an error");
      if (res.errorMessage) {
        assert.ok(/not reachable|connection/i.test(res.errorMessage), `friendly error: ${res.errorMessage}`);
      }
    } finally {
      restoreEnv(originalEnv);
    }
  });
});

test("neighbors with Neo4j env vars set reaches the connection-error path", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ harness, pmRoot }) => {
    const originalEnv = applyEnv(NEO4J_FAIL_ENV);
    try {
      const res = await harness.runCommand({
        command: "pm-graph neighbors",
        args: ["TASK-1"],
        pmRoot,
      }) as CmdResult;
      assert.ok(res.errorMessage || !res.handled, "neighbors connection failure surfaces an error");
      if (res.errorMessage) {
        assert.ok(/not reachable|connection/i.test(res.errorMessage), `friendly error: ${res.errorMessage}`);
      }
    } finally {
      restoreEnv(originalEnv);
    }
  });
});

test("status with Neo4j env vars set reaches the connection-error path", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ ws, harness, pmRoot }) => {
    createItem(ws, "Alpha");
    const originalEnv = applyEnv(NEO4J_FAIL_ENV);
    try {
      const outcome = await harness.runCommand({ command: "pm-graph status", pmRoot }) as CmdResult;
      assert.ok(!outcome.handled || outcome.errorMessage, "status connection failure surfaces an error");
      if (outcome.errorMessage) {
        assert.ok(/not reachable|connection/i.test(outcome.errorMessage), `friendly error: ${outcome.errorMessage}`);
      }
    } finally {
      restoreEnv(originalEnv);
    }
  });
});

// ---------------------------------------------------------------------------
// Exporter adapter via the SDK harness (runExporter)
// ---------------------------------------------------------------------------

test("graph-export exporter renders JSON graph format via the SDK dispatch", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ ws, harness, pmRoot }) => {
    createItem(ws, "Alpha");
    const { stdout } = await captureStdout(async () =>
      harness.runExporter({
        exporter: "graph-export",
        options: { format: "json" },
        pmRoot,
      }),
    );
    const parsed = JSON.parse(stdout) as { graph: { nodes: unknown[] } };
    assert.ok(Array.isArray(parsed.graph?.nodes), "exporter emits valid JSON graph");
  });
});

test("graph-export exporter rejects an invalid --format", { skip: !pmAvailable }, async () => {
  await expectExporterReject({ format: "svg" }, 2, /Unknown --format "svg"/, [/cypher \| mermaid \| dot \| json \| graphml \| plantuml/, "valid formats listed"]);
});

test("graph-export exporter rejects an invalid --edges value", { skip: !pmAvailable }, async () => {
  await expectExporterReject({ format: "json", edges: "bogus" }, 2, /Unknown --edges "bogus"/, [/deps \| tags \| all/, "valid edges listed"]);
});
// ---------------------------------------------------------------------------
// query destructive-keyword guard — rejects before any Neo4j connection
// ---------------------------------------------------------------------------

test("query rejects a destructive Cypher keyword with a USAGE error", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ harness, pmRoot }) => {
    // No Neo4j env required: the destructive-keyword guard runs before the
    // driver is created, so this is fast and exercises a real safety feature.
    await assert.rejects(
      () => harness.runCommand({
        command: "pm-graph query",
        args: ["CREATE (n {x: 1})"],
        pmRoot,
      }),
      expectCommandErrorMulti(2, /Blocked destructive Cypher keyword "CREATE"/, [/Only read-only queries/, "read-only guidance present"]),
    );
  });
});

test("query rejects an empty query with a USAGE error", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ harness, pmRoot }) => {
    await assert.rejects(
      () => harness.runCommand({ command: "pm-graph query", args: ["--json"], pmRoot }),
      expectCommandError(2, /Usage: pm pm-graph query/),
    );
  });
});

// ---------------------------------------------------------------------------
// graph-export exporter — exercisable validation and flag branches
// ---------------------------------------------------------------------------

test("graph-export exporter rejects --depth without --root", { skip: !pmAvailable }, async () => {
  await expectExporterReject({ format: "json", depth: 2 }, 2, /--depth requires --root/);
});

test("graph-export exporter rejects a non-integer --depth", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ ws, harness, pmRoot }) => {
    const root = createItem(ws, "Root");
    await assert.rejects(
      () => harness.runExporter({ exporter: "graph-export", options: { format: "json", root, depth: "abc" }, pmRoot }),
      expectCommandError(2, /Invalid --depth "abc"/),
    );
  });
});

test("graph-export exporter rejects an unknown --root node", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ ws, harness, pmRoot }) => {
    createItem(ws, "Alpha");
    await assert.rejects(
      () => harness.runExporter({ exporter: "graph-export", options: { format: "json", root: "does-not-exist" }, pmRoot }),
      expectCommandError(3, /--root node "does-not-exist" was not found/),
    );
  });
});

test("graph-export exporter rejects an empty --output path", { skip: !pmAvailable }, async () => {
  await expectExporterReject({ format: "json", output: "   " }, 2, /--output requires a file path/);
});

test("graph-export exporter applies a valid --root and --depth neighborhood", { skip: !pmAvailable }, async () => {
  await withCommandWorkspace("pmg-cmd-", async ({ ws, harness, pmRoot }) => {
    const a = createItem(ws, "Alpha");
    createItem(ws, "Beta", a); // neighbour of Alpha
    createItem(ws, "Solo"); // disconnected
    const { stdout } = await captureStdout(async () =>
      harness.runExporter({ exporter: "graph-export", options: { format: "json", root: a, depth: 1 }, pmRoot }),
    );
    const parsed = JSON.parse(stdout) as { graph: { nodes: Array<{ id: string }> } };
    const itemIds = parsed.graph.nodes.filter((n) => n.id.startsWith("pm-")).map((n) => n.id);
    assert.ok(itemIds.includes(a), "root retained");
    assert.ok(!itemIds.includes("Solo"), "disconnected node excluded by neighborhood depth");
  });
});

test("an invalid explicit tracker root fails with a USAGE exit rather than an empty graph", { skip: !pmAvailable }, async () => {
  // The SDK reader resolves with an empty array for an absent path, for a path
  // that is a regular file (swallowing ENOTDIR), and for a directory that is not
  // a tracker. Without assertPmTracker a mistyped --path would make analyze
  // report a confident empty graph and exit 0, where the removed `pm list-all`
  // shell-out exited non-zero. An empty answer for a bad input is worse than a
  // failure, because nothing downstream can detect it.
  const ws = freshWorkspace("pmg-cmd-");
  try {
    const harness = await makeHarness();
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
