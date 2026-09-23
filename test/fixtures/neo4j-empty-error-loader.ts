/** Resolve Neo4j to a module that rejects with an empty-message Error. */

import type { ResolveHookSync } from "node:module";

const emptyErrorUrl = new URL("./neo4j-empty-error.ts", import.meta.url).href;

/** Resolve only the Neo4j package through the empty-message fixture. */
export const resolve: ResolveHookSync = (specifier, context, nextResolve) => {
  if (specifier === "neo4j-driver") return { url: emptyErrorUrl, shortCircuit: true };
  return nextResolve(specifier, context);
};