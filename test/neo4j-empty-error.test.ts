/** Covers an Error-shaped Neo4j import rejection with no message. */

import { registerHooks } from "node:module";

import { resolve as resolveNeo4j } from "./fixtures/neo4j-empty-error-loader.ts";

registerHooks({ resolve: resolveNeo4j });

import assert from "node:assert/strict";
import test from "node:test";

import { withNeo4jQueryTest } from "./helpers.ts";

test("loadNeo4j handles an Error import rejection without a message", async () => {
  await withNeo4jQueryTest("pm-graph-empty-error-", 1, undefined, (result) => {
    assert.match(String(result.errorMessage), /npm install --omit=dev failed with exit code 1/);
  });
});