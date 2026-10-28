import assert from "node:assert/strict";
import { resolve } from "node:path";
import { listAllComplete } from "@unbrained/pm-cli/sdk";
import { projectWorkspaces } from "../src/cross-workspace.ts";
import { isMainInvocation } from "./main-invocation.ts";

import { fingerprint } from "./tracker-fingerprint.ts";
export { fingerprint } from "./tracker-fingerprint.ts";

/** Measure an explicit public tracker copy; verify complete source identity, privacy and no source mutation. */
export async function validateCrossWorkspace(pmRoot: string): Promise<Record<string, number | boolean | string>> {
  const before = fingerprint(pmRoot);
  let sourceReads = 0;
  const readSource = async (): Promise<Awaited<ReturnType<typeof listAllComplete>>> => {
    sourceReads++;
    return listAllComplete({}, { pmRoot, noExtensions: true });
  };
  const snapshot = await readSource();
  const readsBefore = sourceReads;
  const start = performance.now();
  const projection = await projectWorkspaces([
    { key: "public", source: { kind: "directory", pmRoot } },
    { key: "mirror", source: { kind: "directory", pmRoot } },
    { key: "denied", source: { kind: "database", read: readSource } },
  ], { consent: ["public", "mirror", "denied"], authorize: (scope) => scope.key !== "denied", limit: 1000 });
  const elapsedMs = performance.now() - start;
  assert.equal(projection.ok, true);
  assert.equal(projection.complete, false);
  assert.equal(projection.receipt.nodes, snapshot.items.length * 2);
  assert.equal(projection.boundaries.some((boundary) => boundary.code === "UNREADABLE"), true);
  const deniedReads = sourceReads - readsBefore;
  assert.equal(deniedReads, 0);
  assert.equal(fingerprint(pmRoot), before, "read-only source must be byte-identical");
  const firstPage = JSON.stringify(projection);
  return { sourceItems: snapshot.items.length, readableScopes: projection.receipt.readable,
    qualifiedNodes: projection.receipt.nodes, edges: projection.receipt.edges, totalRows: projection.receipt.total,
    returnedRows: projection.receipt.returned, omittedRows: projection.receipt.omitted,
    boundaries: projection.boundaries.length, deniedReads, jsonBytes: Buffer.byteLength(firstPage),
    elapsedMs: Math.round(elapsedMs), sourceUnchanged: true };
}

/** Run the validator on an explicit scratch tracker, emitting only aggregate public-safe measurements. */
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length !== 1) throw new Error("Supply one public tracker copy to validate.");
  console.log(JSON.stringify(await validateCrossWorkspace(resolve(args[0])), null, 2));
}

if (isMainInvocation(process.argv, import.meta.url)) await main();
