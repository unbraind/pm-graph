/**
 * Shared test helpers for pm-graph integration tests.
 *
 * Extracted from the per-file copies in id-resolution, impact-command,
 * diagram-commands, explain-command, command-surface, coverage-gaps, and
 * the neo4j-* test files to eliminate cross-file duplication.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import type { ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension, {
  type CommandContext,
  type ExtensionApi,
  type Graph,
  type GraphNode,
  type GraphRelationship,
} from "../src/index.ts";

export type Handler = (ctx: CommandContext) => Promise<unknown>;

/** Standard result shape returned by the SDK harness `runCommand`. */
export type CmdResult = {
  handled: boolean;
  result: unknown;
  warnings: string[];
  errorMessage?: string;
};

/** Error thrown by handlers with a numeric exit code (1=GENERIC, 2=USAGE, 3=NOT_FOUND). */
export type CommandError = Error & { exitCode: number };

/**
 * Neo4j connection env vars pointing at a dead local port with fast-fail
 * timeouts, used by the command-surface connection-error tests.
 */
export const NEO4J_FAIL_ENV: Readonly<Record<string, string>> = Object.freeze({
  NEO4J_URI: "bolt://127.0.0.1:9",
  NEO4J_USER: "test",
  NEO4J_PASSWORD: "test",
  NEO4J_CONNECTION_TIMEOUT_MS: "300",
  NEO4J_MAX_RETRY_MS: "0",
});

/**
 * Set the standard Neo4j connection env vars (dead port, `neo4j`/`secret`
 * credentials) used by the neo4j-* import-fallback and retry test files.
 */
export function setNeo4jTestEnv(): void {
  process.env.NEO4J_URI = "bolt://127.0.0.1:9";
  process.env.NEO4J_USER = "neo4j";
  process.env.NEO4J_PASSWORD = "secret";
}

/**
 * Apply `overrides` on top of `process.env`, returning a snapshot for later
 * restoration via {@link restoreEnv}.
 */
export function applyEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const original = { ...process.env };
  Object.assign(process.env, overrides);
  return original;
}

/**
 * Build a synthetic {@link GraphNode} with `PmItem` labels and default
 * `Task`/`open` properties, optionally merged with `extra` properties.
 */
export function synthNode(id: string, extra: Record<string, unknown> = {}): GraphNode {
  return { id, labels: ["PmItem"], properties: { id, title: id, type: "Task", status: "open", ...extra } };
}

/** Build a synthetic {@link GraphRelationship} with empty properties. */
export function synthRel(from: string, to: string, type: string): GraphRelationship {
  return { from, to, type, properties: {} };
}

/**
 * Build a synthetic {@link Graph} from arrays of nodes and relationships,
 * with a deterministic timestamp and workspace key.
 */
export function synthGraph(
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  timestamp: string = "2026-01-01T00:00:00.000Z",
): Graph {
  return { generatedAt: timestamp, workspace: "/tmp/ws", projectKey: "ws", nodes, relationships };
}

/** Whether `pm` is available on PATH. */
let pmAvailable = true;
try {
  execFileSync("pm", ["--version"], { encoding: "utf-8" });
} catch {
  pmAvailable = false;
}
export { pmAvailable };

/** Run the real pm CLI against a workspace and return stdout. */
export function pm(cwd: string, args: string[]): string {
  return execFileSync("pm", args, { cwd, encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 });
}

/** Create a fresh temporary pm workspace and return its path. */
export function freshWorkspace(prefix: string = "pmg-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Create a task item and return its id. */
export function createItem(cwd: string, title: string, blockedBy?: string): string {
  const args = ["create", "Task", title, "--json"];
  if (blockedBy) args.push("--blocked-by", blockedBy);
  const out = pm(cwd, args);
  const created = JSON.parse(out) as { id?: string; item?: { id: string } };
  return (created.item?.id ?? created.id) as string;
}

/** Capture console.log output produced while running `fn`. */
export async function captureStdout(fn: () => Promise<unknown>): Promise<{ result: unknown; stdout: string }> {
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

/**
 * Capture console.log output from `fn` which is expected to throw. Returns
 * the captured stdout and the thrown error (or `undefined` if `fn` did not
 * throw). Used by cycle-command tests that assert on diagram output printed
 * before a non-zero exit.
 */
export async function captureStdoutThrow(fn: () => Promise<unknown>): Promise<{ stdout: string; error: unknown }> {
  const original = console.log;
  let buffer = "";
  console.log = (...parts: unknown[]) => {
    buffer += parts.map(String).join(" ") + "\n";
  };
  try {
    await fn();
    return { stdout: buffer, error: undefined };
  } catch (error: unknown) {
    return { stdout: buffer, error };
  } finally {
    console.log = original;
  }
}

/**
 * Activate the extension with a recording API double that captures all
 * command, exporter, and service registrations. Used by tests that need to
 * inspect what was registered (not just dispatch handlers).
 */
export function activateWithRecording(): {
  commands: Map<string, Handler>;
  services: string[];
  exporters: string[];
} {
  const commands = new Map<string, Handler>();
  const services: string[] = [];
  const exporters: string[] = [];
  const api = {
    registerCommand: (cmd: { name: string; run: Handler }) => commands.set(cmd.name, cmd.run),
    registerExporter: (name: string) => exporters.push(name),
    registerImporter: () => {},
    registerHook: () => {},
    registerSchema: () => {},
    registerRenderer: () => {},
    registerSearchProvider: () => {},
    registerPreflight: () => {},
    registerService: (name: string) => services.push(name),
  };
  extension.activate(api as ExtensionApi);
  return { commands, services, exporters };
}

/**
 * Register the pm-graph extension with a hand-rolled API double that records
 * command handlers, so tests can dispatch them directly.
 */
export function collectHandlers(): Map<string, Handler> {
  return activateWithRecording().commands;
}

/** Create the SDK test harness bound to the pm-graph extension. */
export async function makeHarness(): Promise<ExtensionTestHarness> {
  return createExtensionTestHarness(extension, {
    name: "pm-graph",
    capabilities: ["commands", "importers", "services"],
  });
}

/** Restore process.env to a snapshot after mutating it in a test. */
export function restoreEnv(original: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in original)) delete process.env[key];
  }
  Object.assign(process.env, original);
}

/**
 * Create a fake `npm` executable in a temporary directory that exits with the
 * given code (or sends SIGTERM to itself when `mode` is `"signal"`).
 *
 * Returns the directory path — set `process.env.PATH` to it so the next
 * `spawnSync("npm", ...)` call picks up the fake.
 */
export function fakeNpmDir(mode: number | "signal", prefix: string = "pm-graph-npm-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const bin = path.join(dir, "npm");
  const script = mode === "signal" ? "#!/bin/sh\nkill -TERM $$\n" : `#!/bin/sh\nexit ${mode}\n`;
  writeFileSync(bin, script, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return dir;
}

/**
 * Set up a workspace with a 3-item blocked-by chain (Alpha <- Beta <- Gamma)
 * and return the workspace, ids, and the requested command handler.
 */
export function setupChainWorkspace(prefix: string, handlerName: string): {
  ws: string;
  a: string;
  b: string;
  c: string;
  run: Handler;
} {
  const ws = freshWorkspace(prefix);
  pm(ws, ["init"]);
  const a = createItem(ws, "Alpha");
  const b = createItem(ws, "Beta", a);
  const c = createItem(ws, "Gamma", b);
  const run = collectHandlers().get(handlerName)!;
  return { ws, a, b, c, run };
}

/**
 * Set up a workspace with a 2-node dependency cycle (X <-> Y) and return the
 * workspace, ids, and the `pm-graph cycles` handler.
 */
export function setupCycleWorkspace(prefix: string): {
  ws: string;
  x: string;
  y: string;
  run: Handler;
} {
  const ws = freshWorkspace(prefix);
  pm(ws, ["init"]);
  const x = createItem(ws, "X");
  const y = createItem(ws, "Y", x);
  pm(ws, ["update", x, "--blocked-by", y]);
  const run = collectHandlers().get("pm-graph cycles")!;
  return { ws, x, y, run };
}

/**
 * Set up a bare workspace (init only) and return the workspace and the
 * requested command handler. Used by tests that only need a handler without
 * any items.
 */
export function setupBareWorkspace(prefix: string, handlerName: string): {
  ws: string;
  run: Handler;
} {
  const ws = freshWorkspace(prefix);
  pm(ws, ["init"]);
  const run = collectHandlers().get(handlerName)!;
  return { ws, run };
}

/**
 * Set up a fresh workspace (init + harness) and run `fn` with the workspace,
 * harness, and pm-root path. Cleans up the workspace afterwards. Used by the
 * command-surface tests to eliminate repeated workspace/harness boilerplate.
 */
export async function withCommandWorkspace<T>(
  prefix: string,
  fn: (ctx: { ws: string; harness: ExtensionTestHarness; pmRoot: string }) => Promise<T>,
): Promise<T> {
  const ws = freshWorkspace(prefix);
  try {
    pm(ws, ["init"]);
    const harness = await makeHarness();
    const pmRoot = path.join(ws, ".agents", "pm");
    return await fn({ ws, harness, pmRoot });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

/** Run `pm-graph export --format <format>` and return the raw output string. */
export async function runExportRaw(harness: ExtensionTestHarness, pmRoot: string, format: string): Promise<string> {
  const res = await harness.runCommand({
    command: "pm-graph export",
    args: ["--format", format],
    pmRoot,
  }) as CmdResult;
  return (res.result as { __pmGraphRawOutput: string }).__pmGraphRawOutput;
}

/** Create a 3-item chain (Alpha <- Beta <- Gamma) and return the ids. */
export function createChain(ws: string): { a: string; b: string; c: string } {
  const a = createItem(ws, "Alpha");
  const b = createItem(ws, "Beta", a);
  const c = createItem(ws, "Gamma", b);
  return { a, b, c };
}

/**
 * Assert that a `graph-export` exporter call with the given options rejects
 * with a `CommandError` matching the exit code and message patterns.
 */
export async function expectExporterReject(
  options: Record<string, unknown>,
  exitCode: number,
  ...patterns: Array<RegExp | [RegExp, string]>
): Promise<void> {
  await withCommandWorkspace("pmg-cmd-", async ({ harness, pmRoot }) => {
    await assert.rejects(
      () => harness.runExporter({ exporter: "graph-export", options, pmRoot }),
      expectCommandErrorMulti(exitCode, ...patterns),
    );
  });
}

/**
 * Assert that a promise rejects with a `CommandError` whose `exitCode` and
 * `message` match the given values. Returns a matcher function suitable for
 * `assert.rejects`.
 */
export function expectCommandError(
  exitCode: number,
  messagePattern: RegExp,
): (err: CommandError) => boolean {
  return (err: CommandError) => {
    assert.strictEqual(err.exitCode, exitCode);
    assert.match(err.message, messagePattern);
    return true;
  };
}

/**
 * Like {@link expectCommandError} but checks multiple message patterns. Each
 * pattern is either a bare `RegExp` or a `[RegExp, string]` tuple where the
 * string is the assertion message.
 */
export function expectCommandErrorMulti(
  exitCode: number,
  ...patterns: Array<RegExp | [RegExp, string]>
): (err: CommandError) => boolean {
  return (err: CommandError) => {
    assert.strictEqual(err.exitCode, exitCode);
    for (const p of patterns) {
      if (Array.isArray(p)) assert.match(err.message, p[0], p[1]);
      else assert.match(err.message, p);
    }
    return true;
  };
}

/** Recursively remove a set of temporary directories. */
export function cleanupDirs(dirs: Set<string>): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.clear();
}

/**
 * Result shape from a Neo4j query command run through the test harness.
 */
type Neo4jQueryResult = { handled: boolean; errorMessage?: string };

/**
 * Set up a throwaway workspace, optionally install a fake `npm` on `PATH`,
 * set the standard Neo4j test env vars, run `pm-graph query`, invoke `fn`
 * with the result, and clean up — eliminating boilerplate duplication across
 * the neo4j-* import and retry test files.
 *
 * @param prefix Temporary directory prefix for the workspace.
 * @param npmExitCode When non-null, a fake `npm` exiting with this code is
 *   placed on `PATH` before the query runs. `null` skips the install
 *   fallback (the driver is expected to load directly).
 * @param extraEnv Additional env vars to set beyond the standard test set.
 * @param fn Assertion callback receiving the command result.
 */
export async function withNeo4jQueryTest(
  prefix: string,
  npmExitCode: number | null,
  extraEnv: Record<string, string> | undefined,
  fn: (result: Neo4jQueryResult) => Promise<void> | void,
): Promise<void> {
  const fakeNpmDirs = new Set<string>();
  const ws = freshWorkspace(prefix);
  const original = { ...process.env };
  try {
    pm(ws, ["init"]);
    if (npmExitCode !== null) {
      const dir = fakeNpmDir(npmExitCode, `${prefix}-npm-`);
      fakeNpmDirs.add(dir);
      process.env.PATH = dir;
    }
    setNeo4jTestEnv();
    if (extraEnv) Object.assign(process.env, extraEnv);
    const harness = await makeHarness();
    const result = await harness.runCommand({
      command: "pm-graph query",
      args: ["MATCH (n) RETURN n"],
      pmRoot: path.join(ws, ".agents", "pm"),
    }) as Neo4jQueryResult;
    await fn(result);
  } finally {
    restoreEnv(original);
    for (const dir of fakeNpmDirs) rmSync(dir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
}