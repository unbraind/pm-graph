/** Fail the first Neo4j import, then return the default-export fixture on retry. */

const defaultUrl = new URL("./neo4j-fake-default.ts", import.meta.url).href;
let attempts = 0;

/** Resolve Neo4j through one failed import followed by a default-export retry. */
export async function resolve(
  specifier: string,
  context: Record<string, unknown>,
  nextResolve: (specifier: string, context: Record<string, unknown>) => Promise<{ url: string }>,
): Promise<{ url: string; shortCircuit?: boolean }> {
  if (specifier === "neo4j-driver") {
    attempts++;
    if (attempts === 1) throw new Error("Cannot find module neo4j-driver");
    return { url: defaultUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
