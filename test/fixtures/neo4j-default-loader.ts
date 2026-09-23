/** Resolve the Neo4j package to its default-export fixture. */

import type { ResolveHookSync } from "node:module";

const defaultUrl = new URL("./neo4j-fake-default.ts", import.meta.url).href;

/** Resolve only the Neo4j package through the default-export fixture. */
export const resolve: ResolveHookSync = (specifier, context, nextResolve) => {
  if (specifier === "neo4j-driver") return { url: defaultUrl, shortCircuit: true };
  return nextResolve(specifier, context);
};