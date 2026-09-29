/** Contract and scale checks for the pure graph projection used by exports. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import type { ItemMetadata } from "@unbrained/pm-cli/sdk";

import { graphFromItems } from "../src/index.ts";

test("graph projection retains the first dependency edge and external targets", () => {
  const item = {
    id: "item-1", title: "Example", description: "", type: "Task", status: "open",
    priority: 2, created_at: "2026-09-29T00:00:00.000Z", updated_at: "2026-09-29T00:00:00.000Z",
    blocked_by: "external-1", blocked_reason: "waiting",
    dependencies: [{ id: "external-1", kind: "blocked_by", created_at: "2026-09-29T00:00:00.000Z" }],
    tags: [],
  } satisfies ItemMetadata;
  const graph = graphFromItems([item], "/tmp/pm-graph-contract", new Map());
  const edges = graph.relationships.filter((edge) =>
    edge.from === "item-1" && edge.to === "external-1" && edge.type === "BLOCKED_BY");
  assert.equal(edges.length, 1);
  assert.deepEqual(edges[0]?.properties, { source: "blocked_by", reason: "waiting" });
  assert.deepEqual(graph.nodes.find((node) => node.id === "external-1")?.labels, ["ExternalPmItem"]);
});

test("a multi-thousand-item graph with dense facet and dependency edges builds within the export budget", () => {
  const count = 3_000;
  const items = Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    title: `Item ${index}`,
    description: "",
    type: "Task" as const,
    status: "open" as const,
    priority: 2 as const,
    created_at: "2026-09-29T00:00:00.000Z",
    updated_at: "2026-09-29T00:00:00.000Z",
    tags: ["agent", "shared"],
    ...(index > 0 ? {
      parent: `item-${index - 1}`,
      blocked_by: `item-${index - 1}`,
      dependencies: [{ id: `item-${index - 1}`, kind: "blocked_by" as const, created_at: "2026-09-29T00:00:00.000Z" }],
    } : {}),
  })) satisfies ItemMetadata[];
  const start = performance.now();
  const graph = graphFromItems(items, "/tmp/pm-graph-scale", new Map());
  const elapsedMs = performance.now() - start;
  assert.equal(graph.nodes.filter((node) => node.labels.includes("PmItem")).length, count);
  assert.equal(graph.relationships.filter((edge) => edge.type === "BLOCKED_BY").length, count - 1);
  assert.equal(graph.relationships.filter((edge) => edge.type === "CHILD_OF").length, count - 1);
  assert.ok(elapsedMs < 5_000, `3,000-item graph projection took ${elapsedMs.toFixed(0)} ms`);
});
