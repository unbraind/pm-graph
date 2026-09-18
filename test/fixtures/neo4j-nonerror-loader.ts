/** Resolve Neo4j to a module that rejects dynamic import with a non-Error value. */

const nonErrorUrl = new URL("./neo4j-nonerror.ts", import.meta.url).href;

/** Resolve only the Neo4j package through the non-Error fixture. */
export async function resolve(
  specifier: string,
  context: Record<string, unknown>,
  nextResolve: (specifier: string, context: Record<string, unknown>) => Promise<{ url: string }>,
): Promise<{ url: string; shortCircuit?: boolean }> {
  if (specifier === "neo4j-driver") return { url: nonErrorUrl, shortCircuit: true };
  return nextResolve(specifier, context);
}
