/**
 * Covers `loadNeo4j`'s install-on-demand fallback by making `neo4j-driver`
 * unresolvable in this worker, then controlling `npm` on PATH.
 */

import { register } from "node:module";

register("./fixtures/neo4j-throw-loader.ts", import.meta.url);

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../src/index.ts";

type LoaderGlobal = typeof globalThis & {
  __pmGraphNeo4jLoaderMode?: "throw-error" | "throw-string" | "throw-nonerror-eval" | "pass" | "throw-then-pass" | "throw-then-default";
  __pmGraphNeo4jLoaderCount?: number;
};

type CommandError = Error & { exitCode?: number };

let pmAvailable = true;
try {
  execFileSync("pm", ["--version"], { encoding: "utf-8" });
} catch {
  pmAvailable = false;
}

const fakeNpmDirs = new Set<string>();

function freshWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "pm-graph-"));
}

function pm(cwd: string, args: string[]): string {
  return execFileSync("pm", args, { cwd, encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 });
}

function writeFakeNpm(mode: number | "signal"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pm-graph-npm-"));
  fakeNpmDirs.add(dir);
  const bin = path.join(dir, "npm");
  const script = mode === "signal" ? "#!/bin/sh\nkill -TERM $$\n" : `#!/bin/sh\nexit ${mode}\n`;
  writeFileSync(bin, script, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return dir;
}

function restoreEnv(original: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in original)) delete process.env[key];
  }
  Object.assign(process.env, original);
}

test("loadNeo4j install fallback covers spawn failure, non-zero npm, stringify, and retry", { skip: !pmAvailable }, async () => {
  const ws = freshWorkspace();
  const original = { ...process.env };
  const g = globalThis as LoaderGlobal;
  try {
    pm(ws, ["init"]);
    const harness = await createExtensionTestHarness(extension, {
      name: "pm-graph",
      capabilities: ["commands", "importers", "services"],
    });
    const pmRoot = path.join(ws, ".agents", "pm");
    process.env.NEO4J_URI = "bolt://127.0.0.1:9";
    process.env.NEO4J_USER = "neo4j";
    process.env.NEO4J_PASSWORD = "secret";
    process.env.NEO4J_CONNECTION_TIMEOUT_MS = "200";
    process.env.NEO4J_MAX_RETRY_MS = "0";

    const failBin = writeFakeNpm(1);
    process.env.PATH = failBin;
    g.__pmGraphNeo4jLoaderMode = "throw-error";
    const failedInstall = (await harness.runCommand({
      command: "pm-graph query",
      args: ["MATCH (n) RETURN n"],
      pmRoot,
    })) as { errorMessage?: string };
    assert.match(String(failedInstall.errorMessage), /npm install --omit=dev failed with exit code 1/);

    g.__pmGraphNeo4jLoaderMode = "throw-string";
    const failedString = (await harness.runCommand({
      command: "pm-graph query",
      args: ["MATCH (n) RETURN n"],
      pmRoot,
    })) as { errorMessage?: string };
    assert.match(String(failedString.errorMessage), /neo4j-driver missing/);
    assert.match(String(failedString.errorMessage), /npm install --omit=dev failed/);

    g.__pmGraphNeo4jLoaderMode = "throw-nonerror-eval";
    const failedNonError = (await harness.runCommand({
      command: "pm-graph query",
      args: ["MATCH (n) RETURN n"],
      pmRoot,
    })) as { errorMessage?: string };
    assert.match(String(failedNonError.errorMessage), /neo4j-driver missing/);
    assert.match(String(failedNonError.errorMessage), /npm install --omit=dev failed/);

    process.env.PATH = path.join(tmpdir(), "pm-graph-no-such-bin");
    g.__pmGraphNeo4jLoaderMode = "throw-error";
    const missingNpm = (await harness.runCommand({
      command: "pm-graph query",
      args: ["MATCH (n) RETURN n"],
      pmRoot,
    })) as { errorMessage?: string };
    assert.match(String(missingNpm.errorMessage), /ENOENT|not found|npm/i);

    const signalBin = writeFakeNpm("signal");
    process.env.PATH = signalBin;
    g.__pmGraphNeo4jLoaderMode = "throw-error";
    const signaledInstall = (await harness.runCommand({
      command: "pm-graph query",
      args: ["MATCH (n) RETURN n"],
      pmRoot,
    })) as { errorMessage?: string };
    assert.match(String(signaledInstall.errorMessage), /unknown/);

    const okBin = writeFakeNpm(0);
    process.env.PATH = `${okBin}${path.delimiter}${original.PATH ?? ""}`;
    g.__pmGraphNeo4jLoaderMode = "throw-then-default";
    g.__pmGraphNeo4jLoaderCount = 0;
    const retried = (await harness.runCommand({
      command: "pm-graph query",
      args: ["MATCH (n) RETURN n"],
      pmRoot,
    })) as { errorMessage?: string; handled: boolean };
    assert.ok(
      retried.errorMessage || retried.handled,
      "retry import either connects via the real driver or surfaces a connection error",
    );
  } finally {
    restoreEnv(original);
    for (const dir of fakeNpmDirs) rmSync(dir, { recursive: true, force: true });
    fakeNpmDirs.clear();
    rmSync(ws, { recursive: true, force: true });
  }
});
