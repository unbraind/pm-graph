import assert from "node:assert/strict";
import test from "node:test";
import { explainEvidencePath } from "../src/index.ts";
import type { EvidencePathInput, EvidencePathResult } from "../src/index.ts";

/** A two-hop expensive path competes with a three-hop cheap path. */
function fixture(): EvidencePathInput {
  return { nodes: ["a", "b", "c", "d", "z"].map((id) => ({ id })),
    edges: [["a", "b"], ["b", "z"], ["a", "c"], ["c", "d"], ["d", "z"]].map(([from, to]) => ({ from, to, type: "E" })),
    from: "a", to: "z", edgeTypes: ["E"], costs: ["a", "b", "c", "d", "z"].map((id) => ({ id, cost: id === "b" ? 100 : 1 })) };
}

/** Narrow a successful result once, keeping refusal diagnostics on assertion failures. */
function success(input: EvidencePathInput): Extract<EvidencePathResult, { ok: true }> {
  const result = explainEvidencePath(input); assert.ok(result.ok, JSON.stringify(result)); return result;
}

test("cheaper valid witness wins over shortest hops, including endpoint costs", () => {
  const result = success(fixture());
  assert.deepEqual(result.rows.map((row) => [row.path, row.cost, row.hops]), [[["a", "c", "d", "z"], 4, 3], [["a", "b", "z"], 102, 2]]);
  assert.equal(result.optimality, "proved");
  assert.deepEqual(result.rows[0].edges, ["E", "E", "E"]);
  const unit = fixture(); unit.costs.forEach((row) => { row.cost = 1; });
  assert.equal(success(unit).rows[0].cost, 3);
});

test("missing and null costs remain unknown; unrelated unknowns do not block a valid proof", () => {
  const input = fixture(); input.costs = input.costs.filter((row) => row.id !== "b");
  let result = success(input);
  assert.equal(result.optimality, "unknown-costs"); assert.equal(result.rows[0].cost, 4);
  assert.equal(result.rows[1].cost, null); assert.deepEqual(result.rows[1].unknown, ["b"]);
  input.costs = [];
  result = success(input); assert.equal(result.rows[0].cost, null); assert.equal(result.rows[0].knownCost, 0);
  input.costs = [{ id: "a", cost: null }]; assert.equal(success(input).optimality, "unknown-costs");
  const unrelated = fixture(); unrelated.nodes.push({ id: "unused" });
  assert.equal(success(unrelated).optimality, "proved");
  const zero = fixture(); zero.costs.forEach((row) => { row.cost = 0; }); zero.costs = zero.costs.filter((row) => row.id !== "b");
  assert.equal(success(zero).optimality, "proved");
});

test("bounded search returns an incumbent without invented optimality, and may prove a bound early", () => {
  for (const budget of [{ maxSettled: 1 }, { maxWork: 1 }, { maxWork: 3 }]) {
    const result = success({ ...fixture(), ...budget });
    assert.equal(result.optimality, "search-limited"); assert.equal(result.rows[0].cost, 102);
    assert.ok(result.receipt.known.work <= (budget.maxWork ?? 100000));
  }
  const early = success({ ...fixture(), maxWork: 7 });
  assert.equal(early.receipt.optimistic.stop, "maxWork"); assert.equal(early.optimality, "proved");
  assert.equal(early.rows[0].cost, 4); assert.equal(early.receipt.optimistic.lowerBound, 4);
  const zero = fixture(); zero.costs.forEach((row) => { row.cost = 0; });
  assert.equal(success({ ...zero, maxWork: 1 }).optimality, "proved");
  const one = success({ ...fixture(), to: "a", maxWork: 1 });
  assert.equal(one.optimality, "proved"); assert.equal(one.rows[0].hops, 0); assert.equal(one.rows[0].cost, 1);
});

test("cycles, duplicate/parallel arrows, exact identities and disconnected topology", () => {
  const input = fixture(); input.edges.push({ from: "d", to: "a", type: "E" }, { from: "a", to: "a", type: "E" }, ...input.edges);
  assert.equal(success(input).rows[0].cost, 4);
  input.edgeTypes = ["absent"]; const disconnected = success(input);
  assert.equal(disconnected.reachable, false); assert.equal(disconnected.optimality, "no-path"); assert.deepEqual(disconnected.rows, []);
  const exact = [" a ", "__proto__", "constructor", "雪\r\n"];
  const odd: EvidencePathInput = { nodes: exact.map((id) => ({ id })), edges: exact.slice(1).flatMap((id, i) => ["B", "A"].map((type) => ({ from: exact[i], to: id, type }))),
    from: exact[0], to: exact[3], edgeTypes: ["A", "B"], costs: exact.map((id) => ({ id, cost: 1e9 })) };
  const result = success(odd); assert.deepEqual(result.rows[0].path, exact); assert.equal(result.rows[0].cost, 4e9);
  assert.deepEqual(result.rows[0].edges, ["A", "A", "A"]);
});

test("one strict schema refuses malformed and extreme values, while allowing old identity spellings", () => {
  const bad: unknown[] = [Object.assign(Object.create(null) as object, fixture()), { ...fixture(), extra: true }, null, 1, [],
    { ...fixture(), nodes: Array(2) }, { ...fixture(), edges: Array(2) }, { ...fixture(), costs: Array(1) }, { ...fixture(), edgeTypes: Array(1) },
    { ...fixture(), nodes: [{ id: "a", unknown: false, extra: 1 }] }, { ...fixture(), nodes: [{ id: "a", unknown: 1 }] },
    { ...fixture(), edges: [{ from: "a", to: "z", type: "E", cost: 1 }] }, { ...fixture(), costs: [{ id: "a", cost: 1, extra: 1 }] },
    { ...fixture(), costs: [{ id: "absent", cost: 1 }] }, { ...fixture(), costs: [{ id: "a", cost: 1 }, { id: "a", cost: 2 }] },
    { ...fixture(), nodes: [{ id: "a" }, { id: "a" }] }, { ...fixture(), edgeTypes: ["E", "E"] }, { ...fixture(), edgeTypes: [] },
    { ...fixture(), nodes: Array.from({ length: 10001 }, (_, i) => ({ id: String(i) })) },
    { ...fixture(), edges: Array.from({ length: 50001 }, () => ({ from: "a", to: "z", type: "E" })) }];
  for (const value of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_VALUE, Number.MIN_VALUE, "1", null]) {
    for (const key of ["maxSettled", "maxWork", "maxPathNodes"]) bad.push({ ...fixture(), [key]: value });
    if (value !== null) bad.push({ ...fixture(), costs: [{ id: "a", cost: value }] });
  }
  for (const [key, value] of [["maxSettled", 10001], ["maxWork", 1000001], ["maxPathNodes", 1001], ["maxWork", 0], ["from", ""], ["to", " "]] as const) bad.push({ ...fixture(), [key]: value });
  for (const value of bad) {
    const result = explainEvidencePath(value as EvidencePathInput); assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.refusal.code, "INVALID_INPUT", JSON.stringify(value));
  }
  for (const cost of [0, 1, 1e9]) assert.equal(success({ ...fixture(), costs: [{ id: "a", cost }] }).rows[0].cost, null);
  for (const id of ["old id", "a/b", "constructor", "__proto__", " a "]) {
    const result = success({ nodes: [{ id }], edges: [], from: id, to: id, edgeTypes: ["E"], costs: [{ id, cost: 0 }] });
    assert.equal(result.optimality, "proved");
  }
});

test("unavailable topology and oversized witnesses refuse atomically with remedies", () => {
  const inputs = [{ ...fixture(), from: "missing" }, { ...fixture(), to: "missing" },
    { ...fixture(), nodes: fixture().nodes.map((node) => ({ ...node, unknown: node.id === "a" })) },
    { ...fixture(), edges: [...fixture().edges, { from: "a", to: "missing", type: "E" }] },
    { ...fixture(), nodes: fixture().nodes.map((node) => ({ ...node, unknown: node.id === "b" })) }, { ...fixture(), maxPathNodes: 2 }];
  for (const input of inputs) {
    const result = explainEvidencePath(input); assert.ok(!result.ok); assert.ok(result.refusal.remedy); assert.deepEqual(result.rows, []);
  }
});

/** Exhaust all simple paths as an independent reference, with no SDK/path normalization. */
function paths(input: EvidencePathInput): string[][] {
  const found: string[][] = [];
  const visit = (path: string[]): void => {
    if (path.at(-1) === input.to) { found.push(path); return; }
    for (const edge of input.edges) if (edge.from === path.at(-1) && input.edgeTypes.includes(edge.type) && !path.includes(edge.to)) visit([...path, edge.to]);
  };
  visit([input.from]); return found;
}

test("1000 seeded graphs compare known and optimistic exact oracles, bounds, serialization and extreme domains", () => {
  let seed = 0x51c057;
  const random = (max: number): number => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % max; };
  for (let i = 0; i < 1000; i++) {
    const ids = Array.from({ length: 2 + random(6) }, (_, n) => String(n));
    const input: EvidencePathInput = { nodes: ids.map((id) => ({ id })), from: ids[0], to: ids.at(-1)!, edgeTypes: ["E"],
      edges: ids.flatMap((from) => ids.filter(() => random(4) === 0).map((to) => ({ from, to, type: "E" }))),
      costs: ids.map((id) => ({ id, cost: random(4) === 0 ? null : [0, 1, 2, 1e9][random(4)] })) };
    const all = paths(input); const costs = new Map(input.costs.map((row) => [row.id, row.cost]));
    const lower = all.map((path) => path.reduce((sum, id) => sum + (costs.get(id) ?? 0), 0));
    const known = all.filter((path) => path.every((id) => costs.get(id) !== null)).map((path) => path.reduce((sum, id) => sum + costs.get(id)!, 0));
    const minimum = Math.min(...known); const optimistic = Math.min(...lower);
    for (const bounded of [false, true]) {
      const candidate = { ...input, ...(bounded ? { maxWork: 1 + random(30), maxSettled: 1 + random(ids.length) } : {}) };
      const result = success(candidate);
      assert.equal(result.reachable, all.length > 0);
      assert.deepEqual(success(JSON.parse(JSON.stringify(candidate, null, 2).replaceAll("\n", "\r\n")) as EvidencePathInput), result);
      assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
      for (const row of result.rows) {
        assert.ok(all.some((path) => JSON.stringify(path) === JSON.stringify(row.path)));
        assert.equal(row.hops, row.edges.length); assert.equal(new Set(row.path).size, row.path.length);
        if (row.cost !== null) assert.equal(row.cost, row.path.reduce((sum, id) => sum + costs.get(id)!, 0));
      }
      if (result.rows.length) assert.equal(result.rows[1].hops, Math.min(...all.map((path) => path.length - 1)));
      if (result.optimality === "proved") { assert.equal(result.rows[0].cost, minimum); assert.equal(minimum, optimistic); }
      if (!bounded && known.length) assert.equal(result.rows[0].cost, minimum);
      if (result.receipt.optimistic.lowerBound !== null) assert.ok(result.receipt.optimistic.lowerBound <= optimistic);
      assert.ok(result.receipt.known.work <= (candidate.maxWork ?? 100000)); assert.ok(result.receipt.optimistic.work <= (candidate.maxWork ?? 100000));
    }
  }
});
