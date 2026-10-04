/** Fail initial resolution, then return the named-export Neo4j fixture. */
import { retryResolver } from "./neo4j-retry-loader.ts";

/** Real resolution hook with per-module retry state. */
export const resolve = retryResolver(new URL("./neo4j-fake-named.ts", import.meta.url).href);
