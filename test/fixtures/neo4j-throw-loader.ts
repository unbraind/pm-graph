/**
 * ESM resolve hook that fails `neo4j-driver` imports so `loadNeo4j`'s install
 * fallback can run in-process.
 *
 * Mode is read from `globalThis.__pmGraphNeo4jLoaderMode`:
 * - `throw-error` (default): throw an Error
 * - `throw-string`: throw a non-Error so the fallback stringifies it
 * - `pass`: defer to the real specifier (retry-after-install success)
 */

type LoaderMode = "throw-error" | "throw-string" | "pass" | "throw-then-pass";

/**
 * Fail or pass `neo4j-driver` according to the test-controlled loader mode.
 *
 * @param specifier - Module specifier being resolved.
 * @param context - Resolver context from Node's ESM loader.
 * @param nextResolve - Next hook in the chain.
 * @returns The resolved module URL when the mode is `pass`.
 */
export async function resolve(
  specifier: string,
  context: Record<string, unknown>,
  nextResolve: (specifier: string, context: Record<string, unknown>) => Promise<{ url: string }>,
): Promise<{ url: string; shortCircuit?: boolean }> {
  if (specifier === "neo4j-driver") {
    const g = globalThis as typeof globalThis & { __pmGraphNeo4jLoaderMode?: LoaderMode };
    const mode = g.__pmGraphNeo4jLoaderMode ?? "throw-error";
    if (mode === "pass") return nextResolve(specifier, context);
    if (mode === "throw-then-pass") {
      const counted = g as typeof g & { __pmGraphNeo4jLoaderCount?: number };
      counted.__pmGraphNeo4jLoaderCount = (counted.__pmGraphNeo4jLoaderCount ?? 0) + 1;
      if (counted.__pmGraphNeo4jLoaderCount === 1) {
        throw new Error("Cannot find module neo4j-driver");
      }
      return nextResolve(specifier, context);
    }
    if (mode === "throw-string") throw "neo4j-driver missing";
    throw new Error("Cannot find module neo4j-driver");
  }
  return nextResolve(specifier, context);
}
