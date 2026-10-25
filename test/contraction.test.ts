import assert from "node:assert/strict";
import test from "node:test";
import { contractGraph } from "../src/index.ts";
import type { ContractionInput, ContractionResult } from "../src/contraction.ts";

/** Make a small exact directed projection with both reachable and disconnected boundary pairs. */
function fixture(): ContractionInput {
  return { nodes: ["a", "b", "x", "y", "alone"].map((id) => ({ id })),
    edges: [{ from: "a", to: "x", type: "E" }, { from: "a", to: "y", type: "E" }, { from: "x", to: "b", type: "E" }, { from: "y", to: "b", type: "E" }],
    boundary: ["a", "b", "alone"], edgeTypes: ["E"], limit: 1000 };
}
/** Keep tests honest about refusals before inspecting successful evidence. */
function success(input: ContractionInput) {
  const result = contractGraph(input);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("unexpected refusal");
  return result;
}
/** Independent transitive-closure reference model, using no production graph helpers. */
function model(input: ContractionInput): Map<string, Set<string>> {
  const ids = new Set(input.nodes.map((node) => node.id));
  const edges = input.edges.filter((edge) => input.edgeTypes.includes(edge.type));
  for (const edge of edges) { ids.add(edge.from); ids.add(edge.to); }
  const reachable = new Map([...ids].map((id) => [id, new Set([id])]));
  for (const edge of edges) reachable.get(edge.from)!.add(edge.to);
  for (const via of ids) for (const from of ids) for (const to of ids)
    if (reachable.get(from)!.has(via) && reachable.get(via)!.has(to)) reachable.get(from)!.add(to);
  return reachable;
}
/** Check every boundary pair, witness edge, membership and all emitted numeric domains. */
function verify(input: ContractionInput, result: Extract<ContractionResult, { ok: true }>): void {
  const expected = model(input);
  const answers = result.rows.filter((row) => row.kind === "answer");
  assert.equal(answers.length, input.boundary.length ** 2);
  for (const answer of answers) {
    assert.equal(answer.reachable, expected.get(answer.from)!.has(answer.to));
    assert.equal(answer.types.length, Math.max(0, answer.witness.length - 1));
    if (answer.reachable) { assert.equal(answer.witness[0], answer.from); assert.equal(answer.witness.at(-1), answer.to); }
    else assert.deepEqual(answer.witness, []);
    for (let i = 1; i < answer.witness.length; i++) assert.ok(input.edges.some((edge) =>
      edge.from === answer.witness[i - 1] && edge.to === answer.witness[i] && edge.type === answer.types[i - 1] && input.edgeTypes.includes(edge.type)));
  }
  const groups = result.rows.filter((row) => row.kind === "group");
  const members = groups.flatMap((group) => group.members);
  assert.deepEqual([...members].sort(), [...expected.keys()].sort());
  assert.equal(new Set(members).size, members.length);
  // Traverse the independently reconstructed quotient as well as checking the returned answers.
  const quotient: ContractionInput = { nodes: groups.map(({ id }) => ({ id })), edges: result.rows.flatMap((row) => row.kind === "edge" ? [row] : []), boundary: [], edgeTypes: input.edgeTypes };
  const projected = model(quotient);
  const groupOf = (id: string) => groups.find((group) => group.members.includes(id))!.id;
  for (const from of input.boundary) for (const to of input.boundary) assert.equal(projected.get(groupOf(from))!.has(groupOf(to)), expected.get(from)!.has(to));
  for (const [key, value] of Object.entries(result.receipt)) if (typeof value === "number") {
    assert.ok(Number.isFinite(value) && value >= 0, `${key}: ${value}`);
    assert.ok(key === "reduction" ? value <= 1 : Number.isSafeInteger(value));
  }
}

test("equal boundary behavior contracts with all original explanation witnesses", () => {
  const input = fixture(); const result = success(input); verify(input, result);
  assert.ok(result.rows.some((row) => row.kind === "group" && row.members.join(",") === "x,y"));
  const shuffled = structuredClone(input); shuffled.nodes.reverse(); shuffled.edges.reverse(); shuffled.boundary.reverse();
  assert.deepEqual(success(shuffled), result);
  assert.deepEqual(input, fixture(), "projection must not mutate its inputs");
});

test("1000 repeated leaves collapse and membership expands through every page without losing IDs", () => {
  const leaves = Array.from({ length: 1000 }, (_, i) => `leaf-${i}`);
  const input: ContractionInput = { nodes: ["root", ...leaves].map((id) => ({ id })), edges: leaves.map((to) => ({ from: "root", to, type: "E" })), boundary: ["root"], edgeTypes: ["E"] };
  const result = success(input);
  assert.equal(result.receipt.groups, 2); assert.equal(result.receipt.summaryEdges, 1);
  const group = result.rows.find((row) => row.kind === "group" && row.members.length === 1000);
  assert.ok(group && group.kind === "group");
  assert.deepEqual([...group.members].sort(), [...leaves].sort());
  const members: string[] = [];
  let offset = 0;
  do {
    const page = success({ ...input, expand: group.id, limit: 37, offset });
    members.push(...page.rows.flatMap((row) => row.kind === "member" ? [row.id] : []));
    if (page.receipt.nextOffset === null) break;
    offset = page.receipt.nextOffset;
  } while (true);
  assert.deepEqual(members, group.members);
  assert.equal(success({ ...input, offset: 999999 }).rows.length, 0);
});

test("cycles, self-loops and both explicit and dangling unknown endpoints remain singleton and visible", () => {
  const input = fixture();
  input.nodes.push({ id: "external", unknown: true });
  input.edges.push({ from: "x", to: "y", type: "E" }, { from: "y", to: "x", type: "E" }, { from: "alone", to: "alone", type: "E" },
    { from: "a", to: "missing", type: "E" }, { from: "b", to: "external", type: "E" }, { from: "a", to: "ignored-unknown", type: "OTHER" });
  const result = success(input); verify(input, result);
  assert.equal(result.receipt.cycles, 2); assert.equal(result.receipt.unknown, 2);
  for (const row of result.rows) if (row.kind === "group" && (row.cyclic || row.unknown)) assert.equal(row.members.length, 1);
  assert.ok(result.rows.some((row) => row.kind === "cycle" && row.members.includes("x") && row.members.includes("y")));
});

test("exact whitespace, CRLF, Unicode and summary-shaped original IDs survive JSON round trips", () => {
  const ids = ["g0", " g0 ", "x\r\ny", "雪", "__proto__", "a\u0000b"];
  const input: ContractionInput = { nodes: ids.map((id) => ({ id })), edges: ids.slice(1).map((id, i) => ({ from: ids[i], to: id, type: " E " })), boundary: ids, edgeTypes: [" E "], limit: 1000 };
  verify(input, success(input));
  assert.deepEqual(success(JSON.parse(JSON.stringify(input)) as ContractionInput), success(input));
});

test("strict schema refuses sparse arrays, extras, malformed identities and every numeric extreme", () => {
  const invalid: unknown[] = [null, [], {}, { ...fixture(), extra: true }, { ...fixture(), nodes: [undefined] },
    { ...fixture(), nodes: [{ id: "a", extra: 1 }] }, { ...fixture(), nodes: [{ id: "a", unknown: 1 }] },
    { ...fixture(), edges: [{ from: "a", to: "b", type: "E", extra: 1 }] }, { ...fixture(), boundary: ["a", "a"] },
    { ...fixture(), nodes: [{ id: "a" }, { id: "a" }] }, { ...fixture(), edgeTypes: ["E", "E"] },
    { ...fixture(), boundary: [] }, { ...fixture(), edgeTypes: [] }, { ...fixture(), expand: "" },
    { ...fixture(), nodes: new Array(1) }, { ...fixture(), edges: new Array(1) }, { ...fixture(), boundary: new Array(1) }, { ...fixture(), edgeTypes: new Array(1) }];
  for (const key of ["limit", "offset"]) for (const value of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 1, "1", null]) invalid.push({ ...fixture(), [key]: value });
  invalid.push({ ...fixture(), limit: 0 }, { ...fixture(), limit: 1001 }, { ...fixture(), offset: 1000001 });
  for (const value of ["", " ", 1, null, "x".repeat(257)]) invalid.push({ ...fixture(), boundary: [value] });
  for (const value of invalid) {
    const result = contractGraph(value as ContractionInput);
    assert.equal(result.ok, false, JSON.stringify(value));
    if (!result.ok) { assert.equal(result.refusal.code, "INVALID_INPUT"); assert.ok(result.refusal.remedy.length > 20); assert.deepEqual(result.rows, []); }
  }
});

test("work budgets and unknown boundaries/groups refuse atomically", () => {
  for (const [input, code] of [
    [{ ...fixture(), boundary: ["absent"] }, "UNKNOWN_BOUNDARY"],
    [{ ...fixture(), expand: "g999" }, "UNKNOWN_GROUP"],
    [{ nodes: Array.from({ length: 20000 }, (_, i) => ({ id: `n${i}` })), edges: Array.from({ length: 10000 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, type: "E" })), boundary: Array.from({ length: 32 }, (_, i) => `n${i}`), edgeTypes: ["E"] }, "WORK_LIMIT"],
    [{ nodes: [], edges: Array.from({ length: 10001 }, (_, i) => ({ from: `n${2 * i}`, to: `n${2 * i + 1}`, type: "E" })), boundary: ["n0"], edgeTypes: ["E"] }, "WORK_LIMIT"],
  ] as const) {
    const result = contractGraph(input as ContractionInput);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.refusal.code, code);
  }
});

/** Deterministic PRNG makes the failing sequence reproducible from a single seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

test("500 seeded model-based operation sequences include old-input replays, CRLF variants, relationships and output fuzz", () => {
  const next = random(0xc017ac7);
  let transitions = 0;
  for (let sequence = 0; sequence < 500; sequence++) {
    const ids = ["a", "b", " c ", "d\r\ne", "雪", "g0", "unknown"];
    let input: ContractionInput = { nodes: ids.slice(0, -1).map((id) => ({ id })), edges: [], boundary: ["a", "b"], edgeTypes: ["E", "F"], limit: 1000 };
    const history: ContractionInput[] = [];
    for (let step = 0; step < 12; step++) {
      history.push(structuredClone(input));
      const op = Math.floor(next() * 6);
      if (op < 2) input.edges.push({ from: ids[Math.floor(next() * ids.length)], to: ids[Math.floor(next() * ids.length)], type: next() < 0.5 ? "E" : "F" });
      if (op === 2) input.edges.splice(Math.floor(next() * Math.max(1, input.edges.length)), 1);
      if (op === 3) input = structuredClone(history[Math.floor(next() * history.length)]);
      if (op === 4) input.nodes[Math.floor(next() * input.nodes.length)].unknown = next() < 0.5;
      if (op === 5) input.edgeTypes = next() < 0.5 ? ["E"] : ["E", "F"];
      // JSON input replay with whitespace/CRLF variants exercises the full new read-only serialization surface.
      input = JSON.parse(JSON.stringify(input, null, step % 2 ? 2 : 0).replace(/\n/g, "\r\n")) as ContractionInput;
      const result = success(input); verify(input, result);
      assert.deepEqual(JSON.parse(JSON.stringify(result)) as unknown, result);
      transitions++;
    }
  }
  assert.equal(transitions, 6000);
});
