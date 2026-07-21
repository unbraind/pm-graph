import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import extension from "../dist/index.js";

// Resolve this file's directory without relying on the CommonJS `__dirname`,
// which is undefined in ES modules (referencing it throws on Node versions
// where `import.meta.dirname` is also unavailable, i.e. < 20.11).
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Integration tests that exercise the REAL pm CLI contract layer (argument
// validation + output rendering) against a throwaway workspace, covering the
// two fixed bugs:
//   G2: `pm pm-graph export --format json` must emit valid JSON on stdout
//       (not the TOON `ok: true ...` summary), while the default and --json
//       paths stay unchanged.
//   G1: `pm pm-graph neighbors <id>` / `pm pm-graph query "<cypher>"` must
//       accept their documented positional through the contract layer and
//       reach the clear "Neo4j is not configured" error instead of the
//       contract/usage "Too many arguments" rejection.

function pm(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("pm", args, { cwd, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// spawnSync does NOT throw when `pm` is missing (ENOENT) — it returns an
// object with `error` set. Detect availability from the result, not a throw.
const pmProbe = spawnSync("pm", ["--version"], { encoding: "utf-8" });
const pmAvailable = !pmProbe.error && pmProbe.status === 0;

function freshWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "pmg-contract-"));
}

function ensureExtension(ws: string): void {
  // Initialise the tracker then install the locally-built pm-graph from this
  // repo into the throwaway workspace.
  const init = spawnSync("pm", ["init"], { cwd: ws, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
  assert.equal(init.status, 0, `pm init failed: ${init.stdout}\n${init.stderr}`);
  const install = spawnSync(
    "pm",
    ["install", path.resolve(HERE, "..")],
    { cwd: ws, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
  );
  assert.equal(install.status, 0, `pm install failed: ${install.stdout}\n${install.stderr}`);
}

// Smoke-check the module still registers the expected handlers + the service
// override (so the test harness catches a regression in activate() wiring).
test("activate registers the export handler and the output_format service override", () => {
  const commands = new Map<string, unknown>();
  const services: string[] = [];
  const api = {
    registerCommand: (cmd: { name: string }) => commands.set(cmd.name, cmd),
    registerExporter: () => {},
    registerImporter: () => {},
    registerHook: () => {},
    registerSchema: () => {},
    registerRenderer: () => {},
    registerSearchProvider: () => {},
    registerPreflight: () => {},
    registerService: (service: string) => services.push(service),
  };
  extension.activate(api as any);
  assert.ok(commands.has("pm-graph export"), "export command registered");
  assert.ok(services.includes("output_format"), "output_format service override registered");
});

test("export --format json writes valid JSON to stdout (G2)", { skip: !pmAvailable }, () => {
  const ws = freshWorkspace();
  try {
    ensureExtension(ws);
    const res = pm(ws, ["pm-graph", "export", "--format", "json"]);
    assert.equal(res.status, 0, `exit 0\nstdout:\n${res.stdout.slice(0, 500)}\nstderr:\n${res.stderr.slice(0, 500)}`);
    // The entire stdout must be valid JSON (no trailing TOON `ok: true` summary).
    const parsed = JSON.parse(res.stdout) as { graph: { nodes: unknown[]; edges: unknown[] } };
    assert.ok(Array.isArray(parsed.graph?.nodes), "graph.nodes array present");
    assert.ok(Array.isArray(parsed.graph?.edges), "graph.edges array present");
    // And it must NOT be the default {ok, graph} envelope.
    assert.ok(!("ok" in parsed), "--format json emits the raw graph, not the {ok, graph} envelope");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("export default (no --format) is unchanged: TOON ok:true summary (G2 regression guard)", { skip: !pmAvailable }, () => {
  const ws = freshWorkspace();
  try {
    ensureExtension(ws);
    const res = pm(ws, ["pm-graph", "export"]);
    assert.equal(res.status, 0, `exit 0\nstdout:\n${res.stdout.slice(0, 500)}`);
    assert.match(res.stdout, /^ok: true\n/, "default output is the TOON ok:true summary");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("export --json is unchanged: JSON {ok, graph} envelope (G2 regression guard)", { skip: !pmAvailable }, () => {
  const ws = freshWorkspace();
  try {
    ensureExtension(ws);
    const res = pm(ws, ["pm-graph", "export", "--json"]);
    assert.equal(res.status, 0, `exit 0\nstdout:\n${res.stdout.slice(0, 500)}`);
    const parsed = JSON.parse(res.stdout) as { ok: boolean; graph: unknown };
    assert.equal(parsed.ok, true, "--json emits the {ok, graph} envelope");
    assert.ok(parsed.graph, "--json graph present");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("export --format mermaid writes a raw mermaid diagram to stdout (G2 bonus)", { skip: !pmAvailable }, () => {
  const ws = freshWorkspace();
  try {
    ensureExtension(ws);
    const res = pm(ws, ["pm-graph", "export", "--format", "mermaid"]);
    assert.equal(res.status, 0, `exit 0\nstdout:\n${res.stdout.slice(0, 500)}`);
    assert.match(res.stdout, /^graph TD/, "mermaid diagram printed");
    assert.doesNotMatch(res.stdout, /^ok: true/, "no TOON summary prefix");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("export --format <invalid> exits non-zero with a USAGE error (G2)", { skip: !pmAvailable }, () => {
  const ws = freshWorkspace();
  try {
    ensureExtension(ws);
    const res = pm(ws, ["pm-graph", "export", "--format", "svg"]);
    assert.notEqual(res.status, 0, "exits non-zero");
    const combined = res.stdout + res.stderr;
    assert.match(combined, /Unknown --format "svg"/, "clean USAGE error");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("neighbors <node-id> reaches Neo4j-not-configured, not a contract rejection (G1)", { skip: !pmAvailable }, () => {
  const ws = freshWorkspace();
  try {
    ensureExtension(ws);
    const res = pm(ws, ["pm-graph", "neighbors", "TASK-42"]);
    assert.equal(res.status, 2, "uses the expected configuration/usage exit code");
    const combined = res.stdout + res.stderr;
    assert.match(combined, /Neo4j is not configured/, "reaches the clear Neo4j error");
    assert.doesNotMatch(combined, /Too many arguments/, "NOT a contract/usage rejection");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("sync classifies missing Neo4j configuration as expected usage", { skip: !pmAvailable }, () => {
  const ws = freshWorkspace();
  try {
    ensureExtension(ws);
    const res = pm(ws, ["pm-graph", "sync"]);
    assert.equal(res.status, 2, "uses the expected configuration/usage exit code");
    const combined = res.stdout + res.stderr;
    assert.match(combined, /Neo4j is not configured/, "reaches the shared Neo4j configuration guard");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('query "<cypher>" reaches Neo4j-not-configured, not a contract rejection (G1)', { skip: !pmAvailable }, () => {
  const ws = freshWorkspace();
  try {
    ensureExtension(ws);
    const res = pm(ws, ["pm-graph", "query", "MATCH (n) RETURN n LIMIT 5"]);
    assert.equal(res.status, 2, "uses the expected configuration/usage exit code");
    const combined = res.stdout + res.stderr;
    assert.match(combined, /Neo4j is not configured/, "reaches the clear Neo4j error");
    assert.doesNotMatch(combined, /Too many arguments/, "NOT a contract/usage rejection");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('query with Cypher dash tokens (quoted, single arg) is not dropped or misread as a flag', { skip: !pmAvailable }, () => {
  // Documented usage quotes the whole query into ONE arg, so no flag-stripping
  // applies. Guards that a query containing dash tokens that resemble flags
  // (`-h` unary minus, `--` undirected relationship) reaches Neo4j rather than
  // being treated as --help or having tokens dropped.
  const ws = freshWorkspace();
  try {
    ensureExtension(ws);
    const res = pm(ws, ["pm-graph", "query", "MATCH (a) -- (b) WITH 1 AS h RETURN -h"]);
    assert.equal(res.status, 2, "uses the expected configuration/usage exit code (no Neo4j configured)");
    const combined = res.stdout + res.stderr;
    assert.match(combined, /Neo4j is not configured/, "reaches Neo4j rather than a help screen");
    assert.doesNotMatch(combined, /Usage: pm pm-graph query/, "was not misread as --help");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("neighbors with no arg is rejected by the contract layer (G1 regression guard)", { skip: !pmAvailable }, () => {
  const ws = freshWorkspace();
  try {
    ensureExtension(ws);
    const res = pm(ws, ["pm-graph", "neighbors"]);
    assert.notEqual(res.status, 0, "exits non-zero");
    const combined = res.stdout + res.stderr;
    assert.match(combined, /Missing required argument node-id/, "contract enforces the required positional");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("query with a destructive cypher surfaces the blocked-keyword error (G1 regression guard)", { skip: !pmAvailable }, () => {
  const ws = freshWorkspace();
  try {
    ensureExtension(ws);
    const res = pm(ws, ["pm-graph", "query", "CREATE (n) RETURN n"]);
    assert.notEqual(res.status, 0, "exits non-zero");
    const combined = res.stdout + res.stderr;
    assert.match(combined, /Blocked destructive Cypher keyword "CREATE"/, "destructive keyword blocked cleanly");
    assert.doesNotMatch(combined, /Too many arguments/, "not a contract rejection");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("path/impact still accept positionals through the contract layer (G1 sibling guard)", { skip: !pmAvailable }, () => {
  const ws = freshWorkspace();
  try {
    ensureExtension(ws);
    const pathRes = pm(ws, ["pm-graph", "path", "pm-1", "pm-2"]);
    assert.notEqual(pathRes.status, 0, "path exits non-zero (not found)");
    const pathCombined = pathRes.stdout + pathRes.stderr;
    assert.doesNotMatch(pathCombined, /Too many arguments/, "path accepts its positionals");
    assert.match(pathCombined, /not found in the workspace graph/, "path reaches the handler");

    const impactRes = pm(ws, ["pm-graph", "impact", "pm-1"]);
    assert.notEqual(impactRes.status, 0, "impact exits non-zero (not found)");
    const impactCombined = impactRes.stdout + impactRes.stderr;
    assert.doesNotMatch(impactCombined, /Too many arguments/, "impact accepts its positional");
    assert.match(impactCombined, /not found in the workspace graph/, "impact reaches the handler");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// pm-cli 2026.7.18 core `pm graph` collision + pm_root fixes
// ---------------------------------------------------------------------------

test("exporter adapter is registered as graph-export (core `pm graph` collision guard)", () => {
  const exporters: string[] = [];
  const api = {
    registerCommand: () => {},
    registerExporter: (name: string) => exporters.push(name),
    registerImporter: () => {},
    registerHook: () => {},
    registerSchema: () => {},
    registerRenderer: () => {},
    registerSearchProvider: () => {},
    registerPreflight: () => {},
    registerService: () => {},
  };
  extension.activate(api as any);
  assert.ok(exporters.includes("graph-export"), "graph-export adapter registered");
  assert.ok(!exporters.includes("graph"), 'legacy "graph" adapter no longer registered (pm-cli 2026.7.18 owns `pm graph`)');
});

test("export shaping: --edges deps drops facet edges on the canonical command", { skip: !pmAvailable }, () => {
  const ws = freshWorkspace();
  try {
    ensureExtension(ws);
    const a = pm(ws, ["create", "task", "alpha", "--json"]);
    assert.equal(a.status, 0, `create alpha: ${a.stderr}`);
    const b = pm(ws, ["create", "task", "beta", "--json"]);
    assert.equal(b.status, 0, `create beta: ${b.stderr}`);
    type CreateResult = { id?: string; item?: { id: string } };
    const aParsed = JSON.parse(a.stdout) as CreateResult;
    const bParsed = JSON.parse(b.stdout) as CreateResult;
    const aId = (aParsed.item?.id ?? aParsed.id) as string;
    const bId = (bParsed.item?.id ?? bParsed.id) as string;
    const link = pm(ws, ["update", bId, "--blocked-by", aId]);
    assert.equal(link.status, 0, `blocked-by link: ${link.stderr}`);

    const deps = pm(ws, ["pm-graph", "export", "--format", "mermaid", "--edges", "deps"]);
    assert.equal(deps.status, 0, `exit 0\nstdout:\n${deps.stdout.slice(0, 500)}\nstderr:\n${deps.stderr.slice(0, 500)}`);
    assert.match(deps.stdout, /BLOCKED_BY/, "structural edge kept");
    assert.doesNotMatch(deps.stdout, /HAS_TYPE|HAS_STATUS|TAGGED_WITH/, "facet/tag edges dropped");

    const all = pm(ws, ["pm-graph", "export", "--format", "mermaid"]);
    assert.equal(all.status, 0);
    assert.match(all.stdout, /HAS_TYPE/, "no shaping flags keeps the full legacy graph");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("export shaping: invalid --edges and --output without --format are USAGE errors", { skip: !pmAvailable }, () => {
  const ws = freshWorkspace();
  try {
    ensureExtension(ws);
    const badEdges = pm(ws, ["pm-graph", "export", "--edges", "everything"]);
    assert.notEqual(badEdges.status, 0, "invalid --edges exits non-zero");
    assert.match(badEdges.stdout + badEdges.stderr, /Unknown --edges "everything"/);

    const badOutput = pm(ws, ["pm-graph", "export", "--output", "g.json"]);
    assert.notEqual(badOutput.status, 0, "--output without --format exits non-zero");
    assert.match(badOutput.stdout + badOutput.stderr, /--output requires --format/);

    const badDepth = pm(ws, ["pm-graph", "export", "--format", "dot", "--depth", "2"]);
    assert.notEqual(badDepth.status, 0, "--depth without --root exits non-zero");
    assert.match(badDepth.stdout + badDepth.stderr, /--depth requires --root/);

    const fuzzyDepth = pm(ws, ["pm-graph", "export", "--format", "dot", "--root", "x", "--depth", "2abc"]);
    assert.notEqual(fuzzyDepth.status, 0, "partially-numeric --depth exits non-zero");
    assert.match(fuzzyDepth.stdout + fuzzyDepth.stderr, /Invalid --depth "2abc"/, "strict integer validation (not parseInt)");

    const bareFilter = pm(ws, ["pm-graph", "export", "--json", "--filter"]);
    assert.notEqual(bareFilter.status, 0, "valueless --filter exits non-zero");
    assert.match(bareFilter.stdout + bareFilter.stderr, /--filter requires a value/, "bare --filter is rejected, not silently dropped");

    // --include-closed alone is a no-op modifier, NOT a shaping trigger: the
    // full legacy graph (closed included) comes back unchanged.
    const ic = pm(ws, ["pm-graph", "export", "--json", "--include-closed"]);
    assert.equal(ic.status, 0, `--include-closed alone stays legacy: ${ic.stderr}`);
    const icParsed = JSON.parse(ic.stdout) as { ok: boolean };
    assert.equal(icParsed.ok, true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("analytics honour a custom tracker path via pm_root (--pm-path fix)", { skip: !pmAvailable }, () => {
  const ws = freshWorkspace();
  try {
    const init = pm(ws, ["init", "--pm-path", ".pmx"]);
    assert.equal(init.status, 0, `pm init --pm-path failed: ${init.stdout}\n${init.stderr}`);
    const install = pm(ws, ["install", path.resolve(HERE, ".."), "--pm-path", ".pmx"]);
    assert.equal(install.status, 0, `pm install failed: ${install.stdout}\n${install.stderr}`);
    const created = pm(ws, ["create", "task", "gamma", "--pm-path", ".pmx"]);
    assert.equal(created.status, 0, `create failed: ${created.stderr}`);

    const analyze = pm(ws, ["pm-graph", "analyze", "--json", "--pm-path", ".pmx"]);
    assert.equal(analyze.status, 0, `analyze under custom --pm-path: ${analyze.stdout.slice(0, 300)}\n${analyze.stderr.slice(0, 300)}`);
    const parsed = JSON.parse(analyze.stdout) as { ok: boolean; itemCount: number; projectKey: string };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.itemCount, 1, "sees the item stored under the custom tracker path");
    assert.equal(parsed.projectKey, path.basename(ws), "projectKey derives from the workspace, not the hidden storage dir");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
