import assert from "node:assert/strict";
import test from "node:test";

import extension from "../src/index.ts";
import { makeHarness } from "./helpers.ts";

test("extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object", "extension should be an object");
  assert.ok("activate" in extension, "extension should have an activate method");
  assert.strictEqual(typeof extension.activate, "function", "activate should be a function");
});

test("extension registers its declared capabilities through the SDK host", async () => {
  const harness = await makeHarness();
  harness.assertCapabilityUsage({ declared: ["commands", "importers", "services"] });
  harness.assertExporter({ exporter: "graph-export" });
});
