import { record, dense, identity } from "./strict-input.ts";
import type { Graph } from "./index.ts";
import { analyzeKnowledgeGraph, RelationshipGraph, RelationshipKindRegistry } from "@unbrained/pm-cli/sdk/graph";

/** Minimal directed view: metadata and status filtering belong to the source SDK projection. */
export type ContractionInput = {
  nodes: { id: string; unknown?: boolean }[];
  edges: { from: string; to: string; type: string }[];
  boundary: string[];
  edgeTypes: string[];
  limit?: number;
  offset?: number;
  /** Return only membership rows for this summary id, with ordinary pagination. */
  expand?: string;
};
/** Adapt the existing SDK-backed package projection without copying tracker metadata into output. */
export function contractionInputFromGraph(graph: Graph, boundary: string[], edgeTypes: string[]): ContractionInput {
  return { nodes: graph.nodes.map((node) => ({ id: node.id, unknown: !node.labels.includes("PmItem") && node.labels.includes("ExternalPmItem") })),
    edges: graph.relationships.map(({ from, to, type }) => ({ from, to, type })), boundary, edgeTypes };
}
/** Original identities and evidence remain distinct from the summary-id namespace. */
export type ContractionRow =
  | { kind: "group"; id: string; members: string[]; incoming: string[]; outgoing: string[]; cyclic: boolean; unknown: boolean }
  | { kind: "edge"; from: string; to: string; type: string; count: number; witness: [string, string] }
  | { kind: "answer"; from: string; to: string; reachable: boolean; witness: string[]; types: string[] }
  | { kind: "cycle"; members: string[] }
  | { kind: "member"; group: string; id: string };
/** Refusals are atomic: no partial projection is returned as a successful answer. */
export type ContractionRefusalCode = "INVALID_INPUT" | "WORK_LIMIT" | "UNKNOWN_BOUNDARY" | "UNKNOWN_GROUP" | "CONTRACT_VIOLATION" | "SOURCE_INCOMPLETE";
/** Complete source counts and independent, recoverable output pagination. */
export type ContractionReceipt = {
  nodes: number; edges: number; groups: number; summaryEdges: number; boundaryPairs: number;
  cycles: number; unknown: number; reduction: number; total: number; offset: number;
  returned: number; omitted: number; nextOffset: number | null;
};
/** Successful answers certify every selected pair even when output rows are paginated. */
export type ContractionResult =
  | { ok: true; contract: "stored-directed-reachability-v1"; rows: ContractionRow[]; receipt: ContractionReceipt }
  | { ok: false; exit_code: 2; rows: []; refusal: { code: ContractionRefusalCode; remedy: string } };

/** Produce a path-free structured refusal usable by SDK and CLI callers. */
export function contractionRefusal(code: ContractionRefusalCode, remedy: string): ContractionResult {
  return { ok: false, exit_code: 2, rows: [], refusal: { code, remedy } };
}

/** The single strict input schema covers SDK calls and parsed CLI input alike. */
function validInput(value: unknown): value is ContractionInput {
  if (!record(value, ["nodes", "edges", "boundary", "edgeTypes", "limit", "offset", "expand"])) return false;
  return dense(value.nodes, 20000, (node) => record(node, ["id", "unknown"]) && identity(node.id)
      && (node.unknown === undefined || typeof node.unknown === "boolean"))
    && dense(value.edges, 50000, (edge) => record(edge, ["from", "to", "type"]) && identity(edge.from) && identity(edge.to) && identity(edge.type))
    && dense(value.boundary, 32, identity) && value.boundary.length > 0
    && dense(value.edgeTypes, 64, identity) && value.edgeTypes.length > 0
    && new Set(value.nodes.map((node) => (node as { id: string }).id)).size === value.nodes.length
    && new Set(value.boundary).size === value.boundary.length && new Set(value.edgeTypes).size === value.edgeTypes.length
    && (value.limit === undefined || (Number.isSafeInteger(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 1000))
    && (value.offset === undefined || (Number.isSafeInteger(value.offset) && Number(value.offset) >= 0 && Number(value.offset) <= 1000000))
    && (value.expand === undefined || identity(value.expand));
}
/** Index stored arrows without applying ontology inverses or status-name heuristics. */
function indexGraph(ids: string[], edges: { from: string; to: string }[]): RelationshipGraph {
  const registry = new RelationshipKindRegistry([{
    kind: "projection_arrow", direction: "directed", ordering: false, hierarchy: false,
    outgoing: "many", incoming: "many", lifecycle: "ephemeral", compatibilityVersion: 1, allowSelf: true,
  }]);
  // The kernel normalizes node IDs. JSON string encoding preserves exact caller IDs,
  // including surrounding whitespace, without duplicating SDK normalization rules.
  return new RelationshipGraph(ids.map((id) => JSON.stringify(id)), edges.map((edge) => ({ source: JSON.stringify(edge.from), target: JSON.stringify(edge.to), kind: "projection_arrow" })), registry);
}
/** Reflexive reachability includes the root, unlike the kernel closure's returned rows. */
function reach(graph: RelationshipGraph, root: string, direction: "incoming" | "outgoing"): Set<string> {
  return new Set([root, ...graph.closure(JSON.stringify(root), { direction }).value.map((id) => JSON.parse(id) as string)]);
}
/** Reject every invalid emitted number before a successful result leaves the boundary. */
function validNumbers(value: unknown, key = ""): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0
    && (key === "reduction" ? value <= 1 : Number.isSafeInteger(value) && value <= 50000000);
  if (Array.isArray(value)) return value.every((entry) => validNumbers(entry));
  if (value !== null && typeof value === "object") return Object.entries(value).every(([name, entry]) => validNumbers(entry, name));
  return true;
}

/**
 * Collapse equal inbound/outbound boundary signatures, preserving original SCCs and
 * unknown endpoints as singleton groups. All ordered boundary pairs are checked on
 * the quotient before success; witnesses always come from the original SDK index.
 * The result is a read-only explanation view, not a lossless tracker serialization.
 */
export function contractGraph(input: ContractionInput): ContractionResult {
  if (!validInput(input)) return contractionRefusal("INVALID_INPUT", "Supply strict dense nodes/edges, unique exact boundary ids (1-32), edgeTypes (1-64), nodes <=20000, edges <=50000, ids <=256 characters, limit 1-1000 and offset 0-1000000; remove unknown fields.");
  const selected = new Set(input.edgeTypes);
  const edges = input.edges.filter((edge) => selected.has(edge.type));
  const unknown = new Set(input.nodes.filter((node) => node.unknown).map((node) => node.id));
  const ids = new Set(input.nodes.map((node) => node.id));
  for (const edge of edges) for (const id of [edge.from, edge.to]) if (!ids.has(id)) { ids.add(id); unknown.add(id); }
  if (ids.size > 20000) return contractionRefusal("WORK_LIMIT", "Supply at most 20000 distinct nodes including unknown endpoints.");
  const boundary = [...input.boundary].sort();
  if (boundary.some((id) => !ids.has(id))) return contractionRefusal("UNKNOWN_BOUNDARY", "Reload the complete source or choose boundary ids present in nodes or selected edge endpoints.");
  // Conservative upper bound for SCC, two closures per boundary, quotient checks and witnesses.
  if ((ids.size + edges.length + 1) * (4 + 2 * boundary.length + 2 * boundary.length ** 2) > 50000000)
    return contractionRefusal("WORK_LIMIT", "Select fewer boundary ids or edge types, or supply a smaller complete authorized graph; estimated work must be <=50000000.");
  const orderedIds = [...ids].sort();
  const graph = indexGraph(orderedIds, edges);
  const selfLoops = new Set(edges.filter((edge) => edge.from === edge.to).map((edge) => edge.from));
  const cycles = analyzeKnowledgeGraph(graph).stronglyConnected.map((part) => part.map((id) => JSON.parse(id) as string)).filter((part) => part.length > 1 || selfLoops.has(part[0]));
  const cyclic = new Set(cycles.flat());
  const inbound = boundary.map((id) => reach(graph, id, "outgoing"));
  const outbound = boundary.map((id) => reach(graph, id, "incoming"));
  const groups: Extract<ContractionRow, { kind: "group" }>[] = [];
  const buckets = new Map<string, typeof groups[number]>();
  const groupFor = new Map<string, string>();
  for (const id of orderedIds) {
    const incoming = boundary.filter((_, i) => inbound[i].has(id));
    const outgoing = boundary.filter((_, i) => outbound[i].has(id));
    const key = boundary.includes(id) || cyclic.has(id) || unknown.has(id) ? JSON.stringify(["singleton", id]) : JSON.stringify([incoming, outgoing]);
    let group = buckets.get(key);
    if (!group) {
      group = { kind: "group", id: `g${groups.length}`, members: [], incoming, outgoing, cyclic: cyclic.has(id), unknown: unknown.has(id) };
      groups.push(group); buckets.set(key, group);
    }
    group.members.push(id); groupFor.set(id, group.id);
  }
  const summary = new Map<string, Extract<ContractionRow, { kind: "edge" }>>();
  const originalTypes = new Map<string, string>();
  for (const edge of [...edges].sort((a, b) => {
    const left = JSON.stringify([a.from, a.to, a.type]);
    const right = JSON.stringify([b.from, b.to, b.type]);
    return left < right ? -1 : left > right ? 1 : 0;
  })) {
    const from = groupFor.get(edge.from)!; const to = groupFor.get(edge.to)!;
    const key = JSON.stringify([from, to, edge.type]);
    const existing = summary.get(key);
    if (existing) existing.count++;
    else summary.set(key, { kind: "edge", from, to, type: edge.type, count: 1, witness: [edge.from, edge.to] });
    const pair = JSON.stringify([edge.from, edge.to]);
    if (!originalTypes.has(pair)) originalTypes.set(pair, edge.type);
  }
  const quotient = indexGraph(groups.map((group) => group.id), [...summary.values()]);
  const answers: ContractionRow[] = [];
  for (let i = 0; i < boundary.length; i++) {
    const from = boundary[i];
    const projected = reach(quotient, groupFor.get(from)!, "outgoing");
    for (const to of boundary) {
      const reachable = inbound[i].has(to);
      if (reachable !== projected.has(groupFor.get(to)!)) return contractionRefusal("CONTRACT_VIOLATION", "Keep the original graph and report the boundary-equivalence defect with a minimal synthetic graph.");
      const witness = reachable ? graph.shortestPath(JSON.stringify(from), JSON.stringify(to)).value.map((id) => JSON.parse(id) as string) : [];
      const types = witness.slice(1).map((id, j) => originalTypes.get(JSON.stringify([witness[j], id]))!);
      answers.push({ kind: "answer", from, to, reachable, witness, types });
    }
  }
  let rows: ContractionRow[] = [...groups, ...summary.values(), ...cycles.map((members) => ({ kind: "cycle" as const, members })), ...answers];
  if (input.expand !== undefined) {
    const group = groups.find((entry) => entry.id === input.expand);
    if (!group) return contractionRefusal("UNKNOWN_GROUP", "Choose a group id from the current contraction result; group ids are local to this snapshot.");
    rows = group.members.map((id) => ({ kind: "member", group: group.id, id }));
  }
  const total = rows.length; const offset = input.offset ?? 0;
  rows = rows.slice(offset, offset + (input.limit ?? 100));
  const result: ContractionResult = { ok: true, contract: "stored-directed-reachability-v1", rows, receipt: {
    nodes: ids.size, edges: edges.length, groups: groups.length, summaryEdges: summary.size, boundaryPairs: boundary.length ** 2,
    cycles: cycles.length, unknown: unknown.size, reduction: 1 - groups.length / ids.size,
    total, offset, returned: rows.length, omitted: total - rows.length, nextOffset: offset + rows.length < total ? offset + rows.length : null,
  } };
  return validNumbers(result) ? result : contractionRefusal("CONTRACT_VIOLATION", "Keep the original graph and report invalid numeric output with a minimal synthetic graph.");
}
