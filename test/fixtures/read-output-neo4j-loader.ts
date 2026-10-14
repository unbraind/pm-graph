/** Supply deterministic Neo4j transport rows while retaining the real packaged pm host and tracker. */
import { registerHooks } from "node:module";
const fixture = new URL("./read-output-neo4j.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "neo4j-driver" ? { url: fixture, shortCircuit: true } : nextResolve(specifier, context);
  },
});
