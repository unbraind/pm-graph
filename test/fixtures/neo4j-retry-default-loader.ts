/** Fail the first Neo4j resolution, then return the default-export fixture on retry. */

import type { ResolveHookSync } from "node:module";

const defaultUrl = new URL("./neo4j-fake-default.ts", import.meta.url).href;
let attempts = 0;

/** Resolve Neo4j through one failed resolution followed by a default-export retry. */
export const resolve: ResolveHookSync = (specifier, context, nextResolve) => {
  if (specifier === "neo4j-driver") {
    attempts++;
    if (attempts === 1) throw new Error("Cannot find module neo4j-driver");
    return { url: defaultUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
};