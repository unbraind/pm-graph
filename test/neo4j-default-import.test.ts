/** Covers the default-export shape returned by a dynamic Neo4j import. */

import { registerHooks } from "node:module";

import { resolve as resolveNeo4j } from "./fixtures/neo4j-default-loader.ts";

registerHooks({ resolve: resolveNeo4j });

import assert from "node:assert/strict";
import test from "node:test";

import { withNeo4jQueryTest } from "./helpers.ts";

test("loadNeo4j accepts a default-exported driver module", async (t) => {
  await withNeo4jQueryTest(
    "pm-graph-default-",
    null,
    { NEO4J_CONNECTION_TIMEOUT_MS: "200", NEO4J_MAX_RETRY_MS: "0" },
    (result) => {
      assert.equal(result.errorMessage, undefined);
      assert.equal(result.handled, true);
    },
  );
  t.diagnostic("default-export Neo4j fixture exercised");
});