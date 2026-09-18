/** Covers the named-export module shape on the post-install dynamic retry. */

import { register } from "node:module";

register("./fixtures/neo4j-retry-named-loader.ts", import.meta.url);

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../src/index.ts";

/** Create an npm executable that reports a successful install. */
function fakeNpm(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pm-graph-retry-named-npm-"));
  const bin = path.join(dir, "npm");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(bin, 0o755);
  return dir;
}

/** Run the real pm CLI against a temporary tracker. */
function pm(cwd: string, args: string[]): string {
  return execFileSync("pm", args, { cwd, encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 });
}

test("loadNeo4j retries with a named-exported driver after install", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "pm-graph-retry-named-"));
  const original = { ...process.env };
  try {
    pm(ws, ["init"]);
    process.env.PATH = fakeNpm();
    process.env.NEO4J_URI = "bolt://127.0.0.1:9";
    process.env.NEO4J_USER = "neo4j";
    process.env.NEO4J_PASSWORD = "secret";
    const harness = await createExtensionTestHarness(extension, {
      name: "pm-graph",
      capabilities: ["commands", "importers", "services"],
    });
    const result = (await harness.runCommand({
      command: "pm-graph query",
      args: ["MATCH (n) RETURN n"],
      pmRoot: path.join(ws, ".agents", "pm"),
    })) as { handled: boolean; errorMessage?: string };
    assert.equal(result.errorMessage, undefined);
    assert.equal(result.handled, true);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key];
    }
    Object.assign(process.env, original);
    rmSync(ws, { recursive: true, force: true });
  }
});
