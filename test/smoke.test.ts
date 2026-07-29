import assert from "node:assert/strict";
import test from "node:test";

import extension from "../src/index.ts";

test("extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object", "extension should be an object");
  assert.ok("activate" in extension, "extension should have an activate method");
  assert.strictEqual(typeof extension.activate, "function", "activate should be a function");
});

test("extension registers at least one capability", () => {
  const registered: string[] = [];
  const api = {
    registerCommand: () => { registered.push("command"); },
    registerExporter: () => { registered.push("exporter"); },
    registerImporter: () => { registered.push("importer"); },
    registerHook: () => { registered.push("hook"); },
    registerSchema: () => { registered.push("schema"); },
    registerRenderer: () => { registered.push("renderer"); },
    registerSearchProvider: () => { registered.push("search"); },
    registerPreflight: () => { registered.push("preflight"); },
    registerService: () => { registered.push("service"); },
  };
  extension.activate(api as any);
  assert.ok(registered.length > 0, `extension should register at least one capability, got: ${JSON.stringify(registered)}`);
  assert.ok(registered.includes("exporter"), "extension should register the graph exporter");
});
