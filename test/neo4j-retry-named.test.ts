/** Covers the named-export module shape on the post-install dynamic retry. */

import { registerHooks } from "node:module";

import { resolve as resolveNeo4j } from "./fixtures/neo4j-retry-named-loader.ts";

registerHooks({ resolve: resolveNeo4j });

import assert from "node:assert/strict";
import test from "node:test";

import { withNeo4jQueryTest } from "./helpers.ts";

test("loadNeo4j retries with a named-exported driver after install", async () => {
  await withNeo4jQueryTest("pm-graph-retry-named-", 0, undefined, (result) => {
    assert.equal(result.errorMessage, undefined);
    assert.equal(result.handled, true);
  });
});