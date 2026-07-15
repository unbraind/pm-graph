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
