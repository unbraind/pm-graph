/** Shared real loader hook for retrying Neo4j resolution against an export fixture. */
import type { ResolveHookSync } from "node:module";

/** Fail the first Neo4j lookup, route its retry to fixtureUrl, and delegate other modules. */
export function retryResolver(fixtureUrl: string): ResolveHookSync {
  let attempts = 0;
  return (specifier, context, nextResolve) => {
    if (specifier !== "neo4j-driver") return nextResolve(specifier, context);
    attempts++;
    if (attempts === 1) throw new Error("Cannot find module neo4j-driver");
    return { url: fixtureUrl, shortCircuit: true };
  };
}
