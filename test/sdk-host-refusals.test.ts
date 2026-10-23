import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createPmCliExpectedError, EXIT_CODE, isPmCliExpectedError } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { type CommandContext, type ExtensionApi } from "../src/index.ts";

/** Activate the actual graph handler, injecting only a failing input accessor at its tracker boundary. */
async function refusalHarness(failure: unknown, invoked: () => void) {
  return createExtensionTestHarness({
    activate(api: ExtensionApi) {
      extension.activate({
        ...api,
        registerCommand(definition) {
          if (definition.name !== "pm-graph export") return api.registerCommand(definition);
          api.registerCommand({ ...definition, run(context: CommandContext) {
            invoked();
            return definition.run({ ...context, get pm_root(): string { throw failure; } });
          } });
        },
      });
    },
  }, { name: "pm-graph", capabilities: ["commands", "importers", "services", "schema"] });
}

test("graph commands preserve SDK conflict identity, recovery and exit 4 with one invocation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "graph-host-refusal-"));
  const pmRoot = join(workspace, ".agents", "pm");
  const cli = resolve(import.meta.dirname, "../node_modules/@unbrained/pm-cli/dist/cli.js");
  const initialized = spawnSync(process.execPath, [cli, "--no-extensions", "--pm-path", pmRoot, "init", "--defaults", "--agent-guidance", "skip"], {
    cwd: workspace, env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(workspace) }, encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const recovery = { suggested_retry: "Retry after the current writer releases its claim.", retry_after_ms: 100 };
  const refusal = createPmCliExpectedError("Writer conflict", { exitCode: EXIT_CODE.CONFLICT, context: { code: "graph_writer_conflict", recovery } });
  let invocations = 0;
  const harness = await refusalHarness(refusal, () => { invocations++; });
  try {
    assert.deepEqual(harness.activation.failed, []);
    await assert.rejects(harness.runCommand({ command: "pm-graph export", pmRoot }), (error: unknown) => {
      assert.equal(error, refusal);
      assert.ok(isPmCliExpectedError(error));
      assert.equal(error.exitCode, 4);
      assert.equal(error.code, "graph_writer_conflict");
      assert.equal(error.context.recovery, recovery);
      return true;
    });
    assert.equal(invocations, 1);
  } finally { await harness.deactivate(); rmSync(workspace, { recursive: true, force: true }); }
});

test("graph bad arguments are recognized as SDK expected usage errors", async () => {
  const harness = await createExtensionTestHarness(extension, { name: "pm-graph", capabilities: ["commands", "importers", "services", "schema"] });
  try {
    await assert.rejects(harness.runCommand({ command: "pm-graph export", args: ["--format", "invalid"] }), (error: unknown) => {
      assert.ok(isPmCliExpectedError(error));
      assert.equal(error.exitCode, EXIT_CODE.USAGE);
      assert.match(error.message, /Unknown --format/);
      return true;
    });
  } finally { await harness.deactivate(); }
});

test("unexpected graph errors retain contextual messages and their original cause", async () => {
  const cause = new Error("Synthetic read failure");
  const harness = await refusalHarness(cause, () => {});
  try {
    await assert.rejects(harness.runCommand({ command: "pm-graph export" }), (error: unknown) => {
      assert.ok(isPmCliExpectedError(error));
      assert.equal(error.exitCode, EXIT_CODE.GENERIC_FAILURE);
      assert.equal(error.cause, cause);
      assert.match(error.message, /Export failed: Synthetic read failure/);
      return true;
    });
  } finally { await harness.deactivate(); }
});
