import { minimalBlockerCuts } from "./blocker-cuts.ts";
import type { BlockerCutOptions, BlockerCutResult, BlockerCutRefusalCode } from "./blocker-cuts.ts";
import type { Graph, GraphNode } from "./index.ts";

/** Comparison budgets are independent of snapshot capture and host output budgets. */
export type SnapshotImpactOptions = {
  limit?: number;
  offset?: number;
  maxWork?: number;
  cutOptions?: BlockerCutOptions;
};

/** Explanation from the side where a fact existed; text clipping is explicit. */
export type SnapshotNodeContext = { id: string; title: string; status: string; textClipped: boolean };

/** Semantic facts, rather than timestamps, property edits or ordinary item diffs. */
export type SnapshotImpactChange = {
  kind: "reachability-added" | "reachability-removed";
  direction: "upstream" | "downstream";
  node: SnapshotNodeContext;
} | {
  kind: "blocker-cut-added" | "blocker-cut-removed";
  blockers: SnapshotNodeContext[];
  immediatelyUnblocked: boolean;
} | {
  kind: "evidence-added" | "evidence-removed";
  evidence: SnapshotNodeContext;
  target: SnapshotNodeContext;
};

/** Stable machine-readable failures; callers never need to parse diagnostic prose. */
export type SnapshotImpactRefusalCode = "INVALID_OPTIONS" | "INVALID_SNAPSHOT" | "GRAPH_LIMIT" | "UNKNOWN_GOAL" | "INCOMPLETE_GRAPH" | "WORK_LIMIT" | "CUT_REFUSED" | "CUT_SEARCH_INCOMPLETE" | "INPUT_READ" | "INPUT_LIMIT" | "INPUT_JSON";

/** No partial comparison is returned on refusal. Side identifies the failing input. */
export type SnapshotImpactRefusal = {
  ok: false;
  exit_code: 2 | 3;
  code: SnapshotImpactRefusalCode;
  remediation: string;
  changes: [];
  missingNode?: { id: string; before: SnapshotNodeContext | null; after: SnapshotNodeContext | null };
  refusal: { code: SnapshotImpactRefusalCode; remedy: string; side?: "before" | "after"; cutCode?: BlockerCutRefusalCode };
};

/** Bounded rows carry exact totals and an offset for recovering every omitted fact. */
export type SnapshotImpactResult = SnapshotImpactRefusal | {
  ok: true;
  goal: string;
  scope: "supplied-snapshots";
  goalBefore: SnapshotNodeContext | null;
  goalAfter: SnapshotNodeContext | null;
  changed: boolean;
  changes: SnapshotImpactChange[];
  receipt: {
    before: { nodes: number; relationships: number };
    after: { nodes: number; relationships: number };
    work: number;
    cuts: { before: CutReceipt | null; after: CutReceipt | null };
    output: { total: number; returned: number; omitted: number; offset: number; nextOffset: number | null; complete: boolean };
  };
};

type CutReceipt = BlockerCutResult["receipt"]["search"];
type IndexedSnapshot = {
  graph: Graph;
  nodes: Map<string, GraphNode>;
  up: Map<string, Set<string>>;
  down: Map<string, Set<string>>;
  evidence: Map<string, { from: string; to: string }>;
};
const GATING = new Set(["BLOCKED_BY", "DEPENDS_ON", "REQUIRES"]);

/** Construct refusals without copying caller data or local filesystem details. */
export function snapshotImpactRefusal(code: SnapshotImpactRefusalCode, remedy: string, side?: "before" | "after", cutCode?: BlockerCutRefusalCode): SnapshotImpactRefusal {
  return { ok: false, exit_code: code === "UNKNOWN_GOAL" ? 3 : 2, code, remediation: remedy, changes: [], refusal: { code, remedy, ...(side === undefined ? {} : { side }), ...(cutCode === undefined ? {} : { cutCode }) } };
}

/** Check JSON boundaries before indexing, including duplicate ids and bounded identity sizes. */
function indexSnapshot(graph: Graph, side: "before" | "after"): IndexedSnapshot | SnapshotImpactRefusal {
  const invalid = () => snapshotImpactRefusal("INVALID_SNAPSHOT", "Supply a Graph SDK value with unique nonempty ids (at most 256 characters), string labels, properties objects and valid relationships.", side);
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.relationships)) return invalid();
  if (graph.nodes.length > 10_000 || graph.relationships.length > 50_000) {
    return snapshotImpactRefusal("GRAPH_LIMIT", "Supply at most 10000 nodes and 50000 relationships per snapshot; retain the complete goal neighborhood and evidence endpoints.", side);
  }
  const nodes = new Map<string, GraphNode>();
  const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
  const record = (value: unknown): boolean => typeof value === "object" && value !== null && !Array.isArray(value);
  for (const node of graph.nodes) {
    if (!node || !identity(node.id) || nodes.has(node.id) || !Array.isArray(node.labels) || !node.labels.every((label) => typeof label === "string") || !record(node.properties)) return invalid();
    nodes.set(node.id, node);
  }
  const up = new Map<string, Set<string>>();
  const down = new Map<string, Set<string>>();
  const evidence = new Map<string, { from: string; to: string }>();
  for (const edge of graph.relationships) {
    if (!edge || !identity(edge.from) || !identity(edge.to) || !identity(edge.type) || !record(edge.properties)) return invalid();
    if (GATING.has(edge.type) || edge.type === "BLOCKS") {
      const from = edge.type === "BLOCKS" ? edge.to : edge.from;
      const to = edge.type === "BLOCKS" ? edge.from : edge.to;
      if (!up.has(from)) up.set(from, new Set());
      if (!down.has(to)) down.set(to, new Set());
      up.get(from)!.add(to);
      down.get(to)!.add(from);
    }
    if (edge.type === "SUPPORTS" || edge.type === "EVIDENCE_FOR") evidence.set(JSON.stringify([edge.from, edge.to]), { from: edge.from, to: edge.to });
  }
  return { graph, nodes, up, down, evidence };
}

/** Preserve old explanation text while bounding output independently of source title lengths. */
function context(node: GraphNode): SnapshotNodeContext {
  const title = typeof node.properties.title === "string" ? node.properties.title : node.id;
  const status = typeof node.properties.status === "string" ? node.properties.status : "unknown";
  return { id: node.id, title: Array.from(title).slice(0, 160).join(""), status: Array.from(status).slice(0, 64).join(""), textClipped: Array.from(title).length > 160 || Array.from(status).length > 64 };
}

/**
 * Compare an exact goal across two explicit Graph SDK snapshots, without I/O.
 * Reachability uses gating edges in both directions, including terminal nodes.
 * Blocker cuts reuse minimalBlockerCuts (terminal nodes stop active traversal).
 * Explicit SUPPORTS/EVIDENCE_FOR edges support the goal or upstream nodes;
 * they assert structural support only, never validity of external content.
 * Unknown endpoints in a compared cone refuse the result. Reordering, duplicate
 * edges, properties and capture/backend metadata cannot create semantic changes.
 * Search truncation refuses rather than comparing unproven cut absences.
 */
export function compareGraphSnapshots(before: Graph, after: Graph, goal: string, options: SnapshotImpactOptions = {}): SnapshotImpactResult {
  const limit = options.limit ?? 32;
  const offset = options.offset ?? 0;
  const maxWork = options.maxWork ?? 2_000_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxWork) || maxWork < 1 || maxWork > 20_000_000) {
    return snapshotImpactRefusal("INVALID_OPTIONS", "Set limit to 1..256, offset to a nonnegative safe integer, and maxWork to 1..20000000.");
  }
  const left = indexSnapshot(before, "before");
  if ("ok" in left) return left;
  const right = indexSnapshot(after, "after");
  if ("ok" in right) return right;
  const isItem = (index: IndexedSnapshot): boolean => index.nodes.get(goal)?.labels.includes("PmItem") === true;
  if (!isItem(left) && !isItem(right)) return snapshotImpactRefusal("UNKNOWN_GOAL", "Select an exact PmItem id present in at least one supplied snapshot.");
  /** Preserve old explanation context even when a dangling reference prevents proof. */
  const incomplete = (id: string, remedy: string, side: "before" | "after"): SnapshotImpactRefusal => ({
    ...snapshotImpactRefusal("INCOMPLETE_GRAPH", remedy, side),
    missingNode: { id, before: left.nodes.has(id) ? context(left.nodes.get(id)!) : null, after: right.nodes.has(id) ? context(right.nodes.get(id)!) : null },
  });
  const changes: SnapshotImpactChange[] = [];
  let total = 0;
  /** Count every fact but materialize explanation text only for the requested page. */
  const emit = (make: () => SnapshotImpactChange): void => {
    const position = total++;
    if (position >= offset && changes.length < limit) changes.push(make());
  };
  const cuts: { before: CutReceipt | null; after: CutReceipt | null } = { before: null, after: null };
  let work = 0;
  let failure: SnapshotImpactRefusal | undefined;
  const spend = (): boolean => {
    if (++work <= maxWork) return true;
    failure = snapshotImpactRefusal("WORK_LIMIT", "Increase maxWork (CLI --max-work) up to 20000000 or supply smaller certified goal neighborhoods.");
    return false;
  };
  /** Traverse sorted adjacency, retaining deterministic facts and refusing dangling endpoints. */
  const reachable = (index: IndexedSnapshot, direction: "upstream" | "downstream", side: "before" | "after"): Set<string> => {
    const result = new Set<string>();
    const pending = isItem(index) ? [goal] : [];
    const seen = new Set<string>();
    const edges = direction === "upstream" ? index.up : index.down;
    while (pending.length) {
      if (!spend()) break;
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!index.nodes.get(id)?.labels.includes("PmItem")) {
        failure = incomplete(id, "Reload both complete goal neighborhoods, including every referenced prerequisite and dependent. Resolve dangling references to deleted items before comparing blocker cuts.", side);
        break;
      }
      if (id !== goal) result.add(id);
      for (const next of [...(edges.get(id) ?? [])].sort()) {
        if (!spend()) break;
        pending.push(next);
      }
      if (failure) break;
    }
    return result;
  };
  const cones: Array<Set<string>> = [];
  for (const direction of ["upstream", "downstream"] as const) {
    const oldIds = reachable(left, direction, "before");
    if (failure) return failure;
    const newIds = reachable(right, direction, "after");
    if (failure) return failure;
    if (direction === "upstream") cones.push(oldIds, newIds);
    for (const id of [...oldIds].sort()) if (!newIds.has(id)) emit(() => ({ kind: "reachability-removed", direction, node: context(left.nodes.get(id)!) }));
    for (const id of [...newIds].sort()) if (!oldIds.has(id)) emit(() => ({ kind: "reachability-added", direction, node: context(right.nodes.get(id)!) }));
  }
  const cutFacts: Array<Map<string, { blockers: string[]; immediatelyUnblocked: boolean }>> = [];
  for (const [index, side] of [[left, "before"], [right, "after"]] as const) {
    if (!isItem(index)) { cutFacts.push(new Map()); continue; }
    const result = minimalBlockerCuts(index.graph, goal, options.cutOptions);
    if (!result.ok) return snapshotImpactRefusal("CUT_REFUSED", result.refusal.remedy, side, result.refusal.code);
    cuts[side] = result.receipt.search;
    if (!result.receipt.search.complete) return snapshotImpactRefusal("CUT_SEARCH_INCOMPLETE", `Increase cutOptions.${result.receipt.search.reason} (CLI --cut-${result.receipt.search.reason.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}) within the blocker-cut hard caps, or reduce the complete active goal cone. No cut differences were inferred.`, side);
    cutFacts.push(new Map(result.cuts.map((cut) => [JSON.stringify(cut), cut])));
  }
  for (const [source, other, index, kind] of [[cutFacts[0], cutFacts[1], left, "blocker-cut-removed"], [cutFacts[1], cutFacts[0], right, "blocker-cut-added"]] as const) {
    for (const [key, cut] of source) if (!other.has(key)) emit(() => ({ kind, blockers: cut.blockers.map((id) => context(index.nodes.get(id)!)), immediatelyUnblocked: cut.immediatelyUnblocked }));
  }
  const support: Array<Map<string, { from: string; to: string }>> = [];
  for (const [index, cone, side] of [[left, cones[0], "before"], [right, cones[1], "after"]] as const) {
    const facts = new Map<string, { from: string; to: string }>();
    for (const [key, edge] of [...index.evidence].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      if (!spend()) return failure!;
      if ((!isItem(index) || edge.to !== goal) && !cone.has(edge.to)) continue;
      if (!index.nodes.has(edge.from)) return incomplete(edge.from, "Include every evidence endpoint supporting the goal or its prerequisites.", side);
      facts.set(key, edge);
    }
    support.push(facts);
  }
  for (const [source, other, index, kind] of [[support[0], support[1], left, "evidence-removed"], [support[1], support[0], right, "evidence-added"]] as const) {
    for (const [key, edge] of source) if (!other.has(key)) emit(() => ({ kind, evidence: context(index.nodes.get(edge.from)!), target: context(index.nodes.get(edge.to)!) }));
  }
  const page = changes;
  const nextOffset = offset + page.length < total ? offset + page.length : null;
  return { ok: true, goal, scope: "supplied-snapshots", goalBefore: isItem(left) ? context(left.nodes.get(goal)!) : null, goalAfter: isItem(right) ? context(right.nodes.get(goal)!) : null,
    changed: total > 0, changes: page,
    receipt: { before: { nodes: before.nodes.length, relationships: before.relationships.length }, after: { nodes: after.nodes.length, relationships: after.relationships.length }, work, cuts,
      output: { total, returned: page.length, omitted: total - page.length, offset, nextOffset, complete: total === page.length } } };
}
