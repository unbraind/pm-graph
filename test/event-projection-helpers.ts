import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PmClient, listAllComplete, locateItem, readLocatedItem, readSettings, resolveItemTypeRegistry } from "@unbrained/pm-cli/sdk";
import type { ItemMetadata } from "@unbrained/pm-cli/sdk";
import { graphFromItems, readEventProjection, validateEventProjection } from "../src/index.ts";
import type { Graph, EventProjectionOptions, EventProjectionState } from "../src/index.ts";

export const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
/** A real non-git tracker, explicitly isolated from ancestor discovery. */
export function fixture(): { ws: string; pmRoot: string; stateFile: string; client: PmClient } {
  const ws = mkdtempSync(join(tmpdir(), "graph-events-"));
  const result = spawnSync(process.execPath, [cli, "init", "--defaults", "--agent-guidance", "skip", "--prefix", "sparse"], { cwd: ws, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir(), PM_PATH: "" } });
  assert.equal(result.status, 0, result.stderr);
  const pmRoot = join(ws, ".agents/pm");
  return { ws, pmRoot, stateFile: join(ws, "projection.json"), client: new PmClient({ pmRoot, noExtensions: true, author: "graph-test" }) };
}
/** Explicitly clear every source scope field; random ambient focus must never supply a parent. */
export async function seed(client: PmClient, id: string, type = "Task"): Promise<string> {
  const created = await client.create({ id, type, title: id, createMode: "progressive", unset: ["parent", "assignee", "reviewer", "sprint", "release", "blocked_by", "blocked_reason"], clearDeps: true });
  return created.item.id;
}
/** Compare all graph data while ignoring generation time and array order. */
export function comparable(graph: Graph): unknown {
  return JSON.parse(JSON.stringify({ nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)), relationships: [...graph.relationships].sort((a, b) => JSON.stringify([a.from, a.to, a.type]).localeCompare(JSON.stringify([b.from, b.to, b.type]))) }));
}
/** Read model state back through the SDK, with its configured registry and normalization. */
export async function authoritative(pmRoot: string, id: string): Promise<ItemMetadata> {
  const settings = await readSettings(pmRoot);
  const registry = resolveItemTypeRegistry(settings);
  const located = await locateItem(pmRoot, id, undefined, settings.item_format, registry.type_to_folder);
  assert.ok(located);
  return (await readLocatedItem(located, { schema: settings.schema })).document.metadata;
}
/** Check every stored producer result against the validator and full certified SDK projection. */
export async function assertFull(options: EventProjectionOptions): Promise<EventProjectionState> {
  const state = await readEventProjection(options.stateFile);
  assert.ok(state);
  assert.equal(validateEventProjection(JSON.parse(JSON.stringify(state))), true);
  const full = await listAllComplete({}, { pmRoot: options.pmRoot, noExtensions: true });
  assert.deepEqual(comparable(state.graph), comparable(graphFromItems(full.items.sort((a, b) => a.id.localeCompare(b.id)), "projection", new Map())));
  return state;
}
