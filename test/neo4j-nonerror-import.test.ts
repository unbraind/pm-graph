/** Covers non-Error rejection formatting from a dynamic Neo4j import. */

import { registerHooks } from "node:module";

import { resolve as resolveNeo4j } from "./fixtures/neo4j-nonerror-loader.ts";

registerHooks({ resolve: resolveNeo4j });

import assert from "node:assert/strict";
import test from "node:test";

import { withNeo4jQueryTest } from "./helpers.ts";

test("loadNeo4j stringifies a non-Error import rejection", async (t) => {
  await withNeo4jQueryTest("pm-graph-nonerror-", 1, undefined, (result) => {
    assert.match(String(result.errorMessage), /neo4j-driver missing/);
    assert.match(String(result.errorMessage), /npm install --omit=dev failed/);
  });
  t.diagnostic("non-Error import rejection exercised");
});