/** Covers the successful second dynamic import after npm install fallback. */

import { registerHooks } from "node:module";

import { resolve as resolveNeo4j } from "./fixtures/neo4j-retry-default-loader.ts";

registerHooks({ resolve: resolveNeo4j });

import assert from "node:assert/strict";
import test from "node:test";

import { withNeo4jQueryTest } from "./helpers.ts";

test("loadNeo4j retries with a default-exported driver after install", async (t) => {
  await withNeo4jQueryTest("pm-graph-retry-", 0, undefined, (result) => {
    assert.equal(result.errorMessage, undefined);
    assert.equal(result.handled, true);
  });
  t.diagnostic("retry default-export import exercised");
});