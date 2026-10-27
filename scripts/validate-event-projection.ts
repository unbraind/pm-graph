import assert from "node:assert/strict";
import { resolve } from "node:path";
import { listAllComplete } from "@unbrained/pm-cli/sdk";
import { graphFromItems, refreshEventProjection, readEventProjection } from "../src/index.ts";
import { isMainInvocation } from "./main-invocation.ts";

import { fingerprint } from "./tracker-fingerprint.ts";
export { fingerprint } from "./tracker-fingerprint.ts";

/** Read-only public-corpus validation with separate writable projection storage and aggregate-only reporting. */
export async function validateEventProjectionCorpus(pmRoot: string, stateFile: string): Promise<Record<string, number | boolean | string>> {
  const before = fingerprint(pmRoot);
  const snapshot = await listAllComplete({}, { pmRoot, noExtensions: true });
  const start = performance.now();
  const admission = await refreshEventProjection({ pmRoot, stateFile });
  assert.equal(admission.ok, true, JSON.stringify(admission));
  const state = await readEventProjection(stateFile); assert.ok(state);
  const expected = graphFromItems(snapshot.items.sort((a, b) => a.id.localeCompare(b.id)), "projection", new Map());
  const order = <T,>(rows: T[]): T[] => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(order(state.graph.nodes), order(JSON.parse(JSON.stringify(expected.nodes)) as typeof expected.nodes));
  assert.deepEqual(order(state.graph.relationships), order(JSON.parse(JSON.stringify(expected.relationships)) as typeof expected.relationships));
  const caughtUp = await refreshEventProjection({ pmRoot, stateFile });
  assert.equal(caughtUp.ok, true, JSON.stringify(caughtUp));
  assert.equal(caughtUp.fullScans, 0); assert.equal(caughtUp.itemReads, 0);
  assert.equal(fingerprint(pmRoot), before);
  return { sourceItems: snapshot.items.length, nodes: state.graph.nodes.length, edges: state.graph.relationships.length,
    admissionScans: admission.fullScans ?? -1, admissionEvents: admission.events ?? -1,
    catchupScans: caughtUp.fullScans ?? -1, catchupReads: caughtUp.itemReads ?? -1, catchupEvents: caughtUp.events ?? -1,
    catchupJsonBytes: Buffer.byteLength(JSON.stringify(caughtUp)), eventSource: (caughtUp.eventSources ?? []).join(","),
    elapsedMs: Math.round(performance.now() - start), equalToFull: true, authoritativeSourceUnchanged: true };
}
/** Validate an explicitly supplied public tracker copy, retaining projection state outside it. */
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length !== 2) throw new Error("Supply a public tracker copy and a separate projection checkpoint.");
  console.log(JSON.stringify(await validateEventProjectionCorpus(resolve(args[0]), resolve(args[1])), null, 2));
}
if (isMainInvocation(process.argv, import.meta.url)) await main();
