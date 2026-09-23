/** Resolve Neo4j to a module that rejects resolution with a non-Error value. */

import type { ResolveHookSync } from "node:module";

const nonErrorUrl = new URL("./neo4j-nonerror.ts", import.meta.url).href;

/** Resolve only the Neo4j package through the non-Error fixture. */
export const resolve: ResolveHookSync = (specifier, context, nextResolve) => {
  if (specifier === "neo4j-driver") return { url: nonErrorUrl, shortCircuit: true };
  return nextResolve(specifier, context);
};