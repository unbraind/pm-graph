/** Resolve Neo4j to a module that rejects with an empty-message Error. */

const emptyErrorUrl = new URL("./neo4j-empty-error.ts", import.meta.url).href;

/** Resolve only the Neo4j package through the empty-message fixture. */
export async function resolve(
  specifier: string,
  context: Record<string, unknown>,
  nextResolve: (specifier: string, context: Record<string, unknown>) => Promise<{ url: string }>,
): Promise<{ url: string; shortCircuit?: boolean }> {
  if (specifier === "neo4j-driver") return { url: emptyErrorUrl, shortCircuit: true };
  return nextResolve(specifier, context);
}
