/**
 * Sync resolve hook that fails `neo4j-driver` resolution so `loadNeo4j`'s
 * install fallback can run in-process.
 *
 * Mode is read from `globalThis.__pmGraphNeo4jLoaderMode`:
 * - `throw-error` (default): throw an Error
 * - `throw-string`: throw a non-Error so the fallback stringifies it
 * - `pass`: defer to the real specifier (retry-after-install success)
 */

import type { ResolveHookSync } from "node:module";

type LoaderMode =
  | "throw-error"
  | "throw-string"
  | "throw-nonerror-eval"
  | "default"
  | "pass"
  | "throw-then-pass"
  | "throw-then-default";

/**
 * Fail or pass `neo4j-driver` according to the test-controlled loader mode.
 *
 * @param specifier - Module specifier being resolved.
 * @param context - Resolver context from Node's module hooks.
 * @param nextResolve - Next hook in the chain.
 * @returns The resolved module URL when the mode is `pass`.
 */
export const resolve: ResolveHookSync = (specifier, context, nextResolve) => {
  if (specifier === "neo4j-driver") {
    const g = globalThis as typeof globalThis & { __pmGraphNeo4jLoaderMode?: LoaderMode };
    const mode = (process.env.PM_GRAPH_NEO4J_LOADER_MODE as LoaderMode | undefined) ??
      g.__pmGraphNeo4jLoaderMode ?? "throw-error";
    if (mode === "pass") return nextResolve(specifier, context);
    if (mode === "default") {
      return { url: new URL("./neo4j-fake-default.ts", import.meta.url).href, shortCircuit: true };
    }
    if (mode === "throw-nonerror-eval") {
      return { url: new URL("./neo4j-nonerror.ts", import.meta.url).href, shortCircuit: true };
    }
    if (mode === "throw-then-pass" || mode === "throw-then-default") {
      const counted = g as typeof g & { __pmGraphNeo4jLoaderCount?: number };
      counted.__pmGraphNeo4jLoaderCount = (counted.__pmGraphNeo4jLoaderCount ?? 0) + 1;
      if (counted.__pmGraphNeo4jLoaderCount === 1) {
        throw new Error("Cannot find module neo4j-driver");
      }
      if (mode === "throw-then-default") {
        return { url: new URL("./neo4j-fake-default.ts", import.meta.url).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
    if (mode === "throw-string") throw "neo4j-driver missing";
    throw new Error("Cannot find module neo4j-driver");
  }
  return nextResolve(specifier, context);
};