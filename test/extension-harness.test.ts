import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionApi } from "../src/index.ts";
import type { ExtensionModule } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../src/index.ts";
import { cli, fixture } from "./event-projection-helpers.ts";
import { applyEnv, collectHandlers, installBuiltGraphExtension, restoreEnv } from "./helpers.ts";

/** Prove the shared adapter invokes the SDK host, including its real mutation context. */
test("shared command adapter preserves SDK flags, schema, tracker binding and mutation author", async (t) => {
  const f = fixture();
  const original = applyEnv({ PM_AUTHOR: "harness-agent" });
  t.after(() => {
    restoreEnv(original);
    rmSync(f.ws, { recursive: true, force: true });
  });
  const harness = await createExtensionTestHarness({
    activate(api) {
      extension.activate(api as unknown as ExtensionApi);
      api.registerItemFields([{ name: "graph_test_label", type: "string", optional: true }]);
      api.registerCommand({
        // Use an actual graph path so reverting the adapter invokes the old
        // graph callback and fails behaviorally, rather than failing an import.
        name: "pm-graph ping",
        description: "Observe the real host command context in a synthetic tracker.",
        flags: [{ long: "--fixture-label", value_name: "label", description: "Synthetic label" }],
        async run(context) {
          assert.ok(context.sdk, "SDK dispatch must inject the tracker-bound client");
          assert.equal(context.pm_root, f.pmRoot);
          assert.equal(context.global.json, true);
          assert.equal(context.global.author, "harness-agent");
          assert.equal(context.options.fixtureLabel, "synthetic");
          const created = await context.sdk.client.create({ type: "Task", title: "Harness mutation", createMode: "progressive" });
          return { id: created.item.id, author: created.item.author };
        },
      });
    },
  } satisfies ExtensionModule, { name: "pm-graph", capabilities: ["commands", "importers", "services", "schema"] });
  t.after(async () => { await harness.deactivate(); });
  assert.equal(existsSync(join(f.ws, ".git")), false);
  harness.assertFlags({ targetCommand: "pm-graph ping", flags: ["--fixture-label"] });
  harness.assertItemField({ field: "graph_test_label", type: "string" });
  const handlers = await collectHandlers(harness);
  const result = await handlers.get("pm-graph ping")!({
    cwd: f.ws, options: { fixtureLabel: "synthetic" }, global: { author: "harness-agent" },
  }) as { id: string; author: string };
  assert.equal(result.author, "harness-agent");
  const snapshot = await f.client.listAllComplete({});
  assert.deepEqual(snapshot.items.map((item) => item.id), [result.id]);
  assert.equal(snapshot.items[0].title, "Harness mutation");
  assert.equal(snapshot.items[0].author, "harness-agent");
  installBuiltGraphExtension(f.pmRoot);
  const output = spawnSync(process.execPath, [cli, "--pm-path", f.pmRoot, "pm-graph", "export", "--json", "--output-include", "graph.nodes.id", "--output-budget", "unbounded"], { cwd: f.ws, encoding: "utf8", timeout: 30_000 });
  assert.equal(output.status, 0, output.stderr);
  const receipt = JSON.parse(output.stdout) as { read_output: { command: string }; graph: { nodes: Array<{ id: string }> } };
  assert.equal(receipt.read_output.command, "extension:pm-graph export");
  assert.ok(receipt.graph.nodes.some((node) => node.id === result.id));
  for (const node of receipt.graph.nodes) assert.deepEqual(Object.keys(node), ["id"]);
});
