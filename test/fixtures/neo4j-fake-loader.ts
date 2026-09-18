/**
 * ESM resolve hook that redirects `neo4j-driver` to the in-process fake.
 *
 * Registered from coverage tests that need the Neo4j success and error-mapping
 * paths without opening a Bolt socket.
 */

const fakeUrl = new URL("./neo4j-fake-named.mjs", import.meta.url).href;

/**
 * Resolve `neo4j-driver` to {@link fakeUrl}; pass every other specifier through.
 *
 * @param specifier - Module specifier being resolved.
 * @param context - Resolver context from Node's ESM loader.
 * @param nextResolve - Next hook in the chain.
 * @returns The resolved module URL, short-circuited for the fake.
 */
export async function resolve(
  specifier: string,
  context: Record<string, unknown>,
  nextResolve: (specifier: string, context: Record<string, unknown>) => Promise<{ url: string }>,
): Promise<{ url: string; shortCircuit?: boolean }> {
  if (specifier === "neo4j-driver") {
    return { url: fakeUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
