/** Fail the first Neo4j resolution, then return the named-only ESM fixture. */

import type { ResolveHookSync } from "node:module";

const namedUrl = new URL("./neo4j-fake-named.ts", import.meta.url).href;
let attempts = 0;

/** Resolve Neo4j through one failed resolution followed by the named-only retry. */
export const resolve: ResolveHookSync = (specifier, context, nextResolve) => {
  if (specifier === "neo4j-driver") {
    attempts++;
    if (attempts === 1) throw new Error("Cannot find module neo4j-driver");
    return { url: namedUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
};