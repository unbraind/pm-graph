import type { ResolveHookSync } from "node:module";

/** Intercept only package consumers; the fixture proxy and test setup use the real driver. */
export const resolve: ResolveHookSync = (specifier, context, nextResolve) => {
  if (specifier === "neo4j-driver" && /\/(?:src|dist)\/index\.(?:ts|js)$/.test(context.parentURL ?? ""))
    return { url: new URL("./neo4j-live-proxy.ts", import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
};
