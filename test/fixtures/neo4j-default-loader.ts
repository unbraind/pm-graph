/** Resolve the Neo4j package to its default-export fixture. */

const defaultUrl = new URL("./neo4j-fake-default.ts", import.meta.url).href;

/** Resolve only the Neo4j package through the default-export fixture. */
export async function resolve(
  specifier: string,
  context: Record<string, unknown>,
  nextResolve: (specifier: string, context: Record<string, unknown>) => Promise<{ url: string }>,
): Promise<{ url: string; shortCircuit?: boolean }> {
  if (specifier === "neo4j-driver") return { url: defaultUrl, shortCircuit: true };
  return nextResolve(specifier, context);
}
