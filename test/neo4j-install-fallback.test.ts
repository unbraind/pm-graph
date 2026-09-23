/**
 * Covers `loadNeo4j`'s install-on-demand fallback by making `neo4j-driver`
 * unresolvable in this worker, then controlling `npm` on PATH.
 */

import { registerHooks } from "node:module";

import { resolve as resolveNeo4j } from "./fixtures/neo4j-throw-loader.ts";

registerHooks({ resolve: resolveNeo4j });

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { fakeNpmDir, makeHarness, pm, pmAvailable, restoreEnv } from "./helpers.ts";

test("loadNeo4j install fallback covers spawn failure, non-zero npm, and signals", { skip: !pmAvailable }, async () => {
  const fakeNpmDirs = new Set<string>();
  const ws = mkdtempSync(path.join(tmpdir(), "pm-graph-"));
  const original = { ...process.env };
  try {
    pm(ws, ["init"]);
    const harness = await makeHarness();
    const pmRoot = path.join(ws, ".agents", "pm");
    process.env.NEO4J_URI = "bolt://127.0.0.1:9";
    process.env.NEO4J_USER = "neo4j";
    process.env.NEO4J_PASSWORD = "secret";
    process.env.NEO4J_CONNECTION_TIMEOUT_MS = "200";
    process.env.NEO4J_MAX_RETRY_MS = "0";

    const failDir = fakeNpmDir(1, "pm-graph-npm-");
    fakeNpmDirs.add(failDir);
    process.env.PATH = failDir;
    const failedInstall = (await harness.runCommand({
      command: "pm-graph query",
      args: ["MATCH (n) RETURN n"],
      pmRoot,
    })) as { errorMessage?: string };
    assert.match(String(failedInstall.errorMessage), /npm install --omit=dev failed with exit code 1/);

    process.env.PATH = path.join(tmpdir(), "pm-graph-no-such-bin");
    const missingNpm = (await harness.runCommand({
      command: "pm-graph query",
      args: ["MATCH (n) RETURN n"],
      pmRoot,
    })) as { errorMessage?: string };
    assert.match(String(missingNpm.errorMessage), /ENOENT|not found|npm/i);

    const signalDir = fakeNpmDir("signal", "pm-graph-npm-");
    fakeNpmDirs.add(signalDir);
    process.env.PATH = signalDir;
    const signaledInstall = (await harness.runCommand({
      command: "pm-graph query",
      args: ["MATCH (n) RETURN n"],
      pmRoot,
    })) as { errorMessage?: string };
    assert.match(String(signaledInstall.errorMessage), /unknown/);

  } finally {
    restoreEnv(original);
    for (const dir of fakeNpmDirs) rmSync(dir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});