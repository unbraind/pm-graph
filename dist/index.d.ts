import { type Exporter, type ItemMetadata } from "@unbrained/pm-cli/sdk";
import { runGraph } from "@unbrained/pm-cli/sdk/graph";
type CommandContext = {
    command?: string;
    args?: string[];
    cwd?: string;
    workspaceRoot?: string;
    /** Resolved tracker storage path the CLI passes to extension commands (honours --pm-path/--path). */
    pm_root?: string;
    options?: Record<string, unknown>;
    global?: Record<string, unknown>;
};
type ExtensionCommandArgumentDefinition = {
    name: string;
    required?: boolean;
    variadic?: boolean;
    description?: string;
};
type RegisterCommand = {
    name: string;
    description: string;
    run: (context: CommandContext) => Promise<unknown>;
    arguments?: ExtensionCommandArgumentDefinition[];
    intent?: string;
    examples?: string[];
    failure_hints?: string[];
};
type ServiceOverrideContext = {
    service: string;
    command?: string;
    args?: string[];
    options?: Record<string, unknown>;
    global?: Record<string, unknown>;
    pm_root?: string;
    payload?: unknown;
};
type ExtensionApi = {
    registerCommand(command: RegisterCommand): void;
    registerExporter(name: string, exporter: Exporter): void;
    registerService(service: "output_format" | "error_format" | "help_format" | "lock_acquire" | "lock_release" | "history_append" | "item_store_write" | "item_store_delete" | "context_relevance", override: (context: ServiceOverrideContext) => unknown): void;
};
type GraphNode = {
    id: string;
    labels: string[];
    properties: Record<string, unknown>;
};
type GraphRelationship = {
    from: string;
    to: string;
    type: string;
    properties: Record<string, unknown>;
};
type Graph = {
    generatedAt: string;
    workspace: string;
    projectKey: string;
    nodes: GraphNode[];
    relationships: GraphRelationship[];
};
/**
 * Invoke the canonical registry-aware graph engine in-process via the SDK's
 * {@link runGraph}, honouring `--path <pm_root>` through `global.path`.
 *
 * This is the same engine that backs `pm graph <subcommand>`; calling it
 * directly rather than spawning `pm` removes the subprocess, the JSON
 * re-parse, and the output-size ceiling that a piped `--json` read imposes —
 * a large workspace could previously exceed the shell-out's buffer and fail
 * the query rather than answer it. It also drops the requirement that a `pm`
 * binary be resolvable on `PATH`, which is not guaranteed for a
 * package-backed extension.
 *
 * Availability is a compile-time guarantee: the engine is imported statically
 * from the declared `@unbrained/pm-cli` peer dependency, so the former
 * `pm graph --help` probe (and its degraded fallback) is no longer meaningful
 * and has been removed.
 *
 * Since pm-cli 2026.8.3 the engine returns `ProjectedGraphResult` — the union
 * of every subcommand envelope intersected with the output-projection
 * declaration. That type is not re-exported from the public `sdk/graph`
 * surface, so the return type here is taken from {@link runGraph} itself via
 * `ReturnType` instead of being re-declared locally, where a hand-maintained
 * copy would drift. Callers narrow the union on the `subcommand` discriminant
 * carried by every envelope, so no cast appears anywhere on this path.
 */
/**
 * Narrow the SDK's projected graph union at the canonical impact call site.
 *
 * @param result - The real SDK response returned for a graph command.
 * @returns The impact projection when the requested subcommand honored its contract.
 * @throws {CommandError} When the SDK returns a different envelope.
 */
export declare function requireImpactResult(result: Awaited<ReturnType<typeof runGraph>>): Extract<Awaited<ReturnType<typeof runGraph>>, {
    subcommand: "impact";
}>;
/**
 * Build a workspace graph (nodes + relationships) from pm item metadata.
 *
 * Emits one `PmItem` node per item, then derives edges from the item's
 * structural fields: `CHILD_OF` for a parent, `BLOCKED_BY` for a blocker, and
 * a normalized relationship per dependency (merging the legacy `deps[]` and
 * typed `dependencies[]`, de-duplicated by `from->to:type`). Facet fields
 * (type/status/assignee/sprint/release) and tags become `PmFacet` nodes with
 * their own edges. A relationship whose target is not among the items — and
 * not already a node — is materialized as an `ExternalPmItem` so the graph
 * never dangles a half-edge.
 *
 * @param items - pm item metadata to project.
 * @param workspace - Workspace path, recorded on the returned graph.
 * @param depsByItem - Extra dependency records keyed by item id.
 * @returns The shaped graph with project metadata.
 */
export declare function graphFromItems(items: readonly ItemMetadata[], workspace: string, depsByItem: Map<string, Array<Record<string, unknown>>>): Graph;
type AnalyticsFlags = {
    json: boolean;
    includeClosed: boolean;
    root?: string;
    depth?: number;
    format: "text" | AnalysisDiagramFormat;
    filter: NodeFilter;
    positionals: string[];
    /** Logical impact direction (downstream|upstream|both); consumed by `pm-graph impact`. */
    direction?: string;
    /** Row cap for bounded collections; consumed by `pm-graph impact`. */
    limit?: number;
};
/**
 * Parse the shared analytics flags (--json, --include-closed, --root, --depth,
 * --format, --filter) and collect remaining positional arguments. Throws a USAGE
 * CommandError on a malformed --depth, an invalid --format, a malformed
 * --filter, or a value-less --root/--depth/--format/--filter.
 */
export declare function parseAnalyticsFlags(args: string[]): AnalyticsFlags;
/** Raw offline render formats accepted by `pm graph export`. */
export type ExportFormat = "cypher" | "mermaid" | "dot" | "json" | "graphml" | "plantuml";
/** Which relationship classes an analysis or export should keep. */
export type EdgeFilter = "deps" | "tags" | "all";
/** A single `--filter` term: keep PmItem nodes whose `key` property is one of `values`. */
export type NodeFilterEntry = {
    key: "type" | "status";
    values: string[];
};
/** Node filter (AND across entries, OR within an entry's values). */
export type NodeFilter = NodeFilterEntry[];
/**
 * Parse one or more `key=value[,value]` filter terms into a NodeFilter.
 * Throws a USAGE CommandError on a missing `=`, an unsupported key, or an
 * empty value list. Values are matched case-insensitively.
 */
export declare function parseNodeFilter(raw: string[]): NodeFilter;
/**
 * Whether a node survives a NodeFilter. Non-PmItem nodes (facets, tags,
 * external items) always survive — the filter scopes workspace *items* only.
 * For PmItem nodes, every entry must match (AND); an entry matches when the
 * node's (lowercased) `key` property is one of the entry's values (OR).
 */
export declare function matchesNodeFilter(node: GraphNode, filter: NodeFilter): boolean;
/**
 * Render a graph as a Mermaid `graph TD` document.
 *
 * Each node is drawn as a boxed label showing title, id, and status, with the
 * id sanitized through {@link mermaidId} (Mermaid ids must be alphanumeric) and
 * the label escaped through {@link mermaidLabel}. Relationships become
 * directed arrows labelled with their type; a blank line separates nodes from
 * edges only when there are edges, so an edge-free graph stays compact.
 */
export declare function renderMermaid(graph: Graph): string;
/** A JSON Graph Format-style document (nodes/edges) for generic graph tooling. */
export declare function renderJsonGraph(graph: Graph): string;
/**
 * Render a valid GraphML XML document (consumable by yEd / Gephi / NetworkX).
 * Declares string keys for node title/type/status/labels and edge type, then
 * emits one <node> per graph node and one <edge> per relationship.
 */
export declare function renderGraphml(graph: Graph): string;
/**
 * Render a PlantUML object diagram (`@startuml`…`@enduml`) with one object per
 * node and one arrow per relationship, the relationship type as the arrow
 * label. Renders with PlantUML / Structurizr / many docs toolchains.
 */
export declare function renderPlantuml(graph: Graph): string;
type StructuralEdge = {
    from: string;
    to: string;
    type: string;
};
/**
 * Detect all elementary directed cycles among structural edges using an
 * iterative DFS with a recursion stack. Returns each cycle as an ordered id
 * path whose first and last ids are equal (e.g. [E, F, E]). The DFS roots
 * each cycle at its smallest id, so A->B->A and B->A->B share one key.
 */
export declare function findCycles(nodes: string[], edges: StructuralEdge[]): string[][];
/**
 * Shortest directed path from `from` to `to` over structural edges (BFS).
 * Returns the ordered id path (inclusive of both endpoints) or null if no path
 * exists. Returns [from] when from === to.
 */
export declare function shortestPath(edges: StructuralEdge[], from: string, to: string): string[] | null;
/**
 * Longest dependency chain (critical path) over structural edges. Uses a
 * memoised DFS that is safe on cyclic graphs (nodes on the active recursion
 * stack are skipped, so a cycle cannot inflate the chain infinitely). Returns
 * the ordered id list of the longest simple chain found.
 */
export declare function longestChain(nodes: string[], edges: StructuralEdge[]): string[];
/**
 * Topological execution order over structural edges using Kahn's algorithm.
 *
 * Edges point from an item to its blocker/dependency (e.g. B --BLOCKED_BY--> A
 * means "B is blocked by A", so A must be done before B). A valid execution
 * order therefore lists a node only after every node it points to. We compute
 * that order by treating out-edges as prerequisites: repeatedly emit nodes whose
 * out-degree (unsatisfied prerequisites) has dropped to zero.
 *
 * Returns `{ order, cycleNodes }`. When the graph is acyclic, `order` contains
 * every node and `cycleNodes` is empty. When a cycle exists, the nodes that
 * could not be ordered are returned in `cycleNodes` (and `order` holds the
 * resolvable prefix). Ties are broken by ascending id for deterministic output.
 */
export declare function topoSort(nodes: string[], edges: StructuralEdge[]): {
    order: string[];
    cycleNodes: string[];
};
/**
 * Reverse-reachable set from `start` over structural edges: every node that can
 * reach `start` by following edge direction (i.e. everything transitively
 * blocked-by / downstream of `start`). With edges pointing item -> blocker, the
 * dependents of X are the nodes with an edge INTO X, so we walk edges backwards
 * via a reverse adjacency (BFS). Excludes `start` itself. Result is sorted.
 */
export declare function reverseReachable(edges: StructuralEdge[], start: string): string[];
/**
 * Longest-path depth per node: the number of edges on the longest directed
 * structural path STARTING at the node (its distance to a leaf along blocker
 * edges). A leaf (no outgoing edge) has depth 0. Cycle-safe: nodes on the active
 * recursion stack are skipped so a cycle cannot inflate depth infinitely. This
 * is the "longest path from any root" metric expressed per node, since the
 * deepest node is exactly the far end of the critical path.
 */
export declare function dependencyDepths(nodes: string[], edges: StructuralEdge[]): Map<string, number>;
/**
 * Find the articulation points and bridges of the dependency graph.
 *
 * Treats the graph as UNDIRECTED: each edge adds both directions, self-loops
 * are dropped, and Tarjan's discovery/low DFS flags a node as an articulation
 * point when its removal would disconnect the graph, and an edge as a bridge
 * when it is the only connection between two parts. The root is special-cased
 * (it is critical only with more than one DFS child). Both results are sorted
 * for deterministic output — these are the items and links whose loss most
 * damages workspace connectivity.
 *
 * @param nodes - Item ids participating in the graph.
 * @param edges - Structural directed edges; read symmetrically here.
 * @returns Sorted articulation point ids and sorted bridge edges.
 */
export declare function criticalConnectors(nodes: string[], edges: StructuralEdge[]): {
    articulationPoints: string[];
    bridges: Array<{
        from: string;
        to: string;
    }>;
};
/** Diagram output formats supported by the analysis commands. */
export type AnalysisDiagramFormat = "mermaid" | "graphml" | "dot";
/**
 * Project a subgraph of `graph` containing exactly the nodes in `nodeIds` (in
 * the order given, de-duplicated) and exactly the relationships identified by
 * `edgeKeys` (each `${from}->${to}`). Node properties/labels and relationship
 * properties are preserved verbatim from the source graph so the existing
 * renderers (renderMermaid / renderGraphml) produce labelled output. Edge keys
 * that have no matching relationship in the source graph are skipped, so the
 * subgraph never invents edges.
 */
export declare function projectSubgraph(graph: Graph, nodeIds: string[], edgeKeys: string[]): Graph;
/**
 * Build the subgraph for a critical-path `chain` (an ordered id list): the
 * chain nodes plus the consecutive edges that connect them.
 */
export declare function criticalPathSubgraph(graph: Graph, chain: string[]): Graph;
/**
 * Build the subgraph for a set of detected `cycles` (each a closed id path
 * whose first === last): the union of all participating nodes plus the
 * consecutive edges around every cycle. Node order is the first-seen order
 * across cycles for deterministic output.
 */
export declare function cyclesSubgraph(graph: Graph, cycles: string[][]): Graph;
/**
 * Map a logical `pm-graph impact` direction to the canonical `pm graph impact`
 * `--direction` value. The canonical engine uses edge-orientation terms:
 * `incoming` = downstream dependents (items that break if <id> changes —
 * exactly the legacy `reverseReachable` semantics), `outgoing` = upstream
 * prerequisites/blockers, `both` = union. Throws a USAGE `CommandError` on an
 * unknown logical direction.
 */
export declare function mapImpactDirection(logical: string): "incoming" | "outgoing" | "both";
/**
 * Build the impact subgraph for the canonical `pm graph impact` result: the
 * root node plus every node on every returned `path` (affected items and their
 * intermediate hops) and the structural edges along those paths. Each
 * consecutive path pair contributes both `u->v` and `v->u` candidate edge
 * keys; `projectSubgraph` keeps only the keys that match a real structural
 * relationship in the source graph, so the traversal direction of the path
 * (which differs between `incoming`/`outgoing`) never fabricates edges. The
 * root is always the first node so diagrams anchor on it.
 */
export declare function impactSubgraph(graph: Graph, rootId: string, affected: Array<{
    id: string;
    distance?: number;
    path?: string[];
}>): Graph;
/**
 * Build the impact subgraph for the legacy fallback path (no traversal
 * paths available): the root plus the impacted node set, with every
 * structural edge whose endpoints both fall inside that set. Used when the
 * canonical `pm graph` engine is unavailable and the diagram format is still
 * requested. Mirrors `impactSubgraph`'s node anchoring (root first).
 */
export declare function impactSubgraphFromNodeSet(graph: Graph, rootId: string, nodeIds: string[]): Graph;
/** Render an analysis subgraph via the existing full-graph renderers. */
export declare function renderAnalysisDiagram(format: AnalysisDiagramFormat, graph: Graph): string;
type AnalyzeReport = {
    workspace: string;
    projectKey: string;
    itemCount: number;
    structuralEdgeCount: number;
    cycleCount: number;
    cycles: string[][];
    orphanCount: number;
    orphans: string[];
    rootCount: number;
    roots: string[];
    leafCount: number;
    leaves: string[];
    longestChainLength: number;
    longestChain: string[];
    connectedComponents: number;
    blockedItemCount: number;
    blockedItems: string[];
    topDegreeCentrality: Array<{
        id: string;
        degree: number;
        inDegree: number;
        outDegree: number;
    }>;
    maxDepth: number;
    depthByItem: Array<{
        id: string;
        depth: number;
    }>;
    articulationPointCount: number;
    articulationPoints: string[];
    bridgeEdgeCount: number;
    bridgeEdges: Array<{
        from: string;
        to: string;
    }>;
};
/**
 * One immediate neighbour of an explained item, with the relation types that
 * connect it. Multiple edges to the same neighbour collapse into one entry
 * whose `relationTypes` lists each.
 */
export type ExplainNeighbor = {
    id: string;
    title: string;
    status: string | null;
    relationTypes: string[];
};
/**
 * The full focused report for one item: its own fields, its immediate blockers
 * and dependents, the transitive set that depends on it, dependency depth, the
 * critical chain leading to it, and every cycle it participates in. Designed
 * to be small enough to hand directly to an agent.
 */
export type ExplainReport = {
    id: string;
    item: {
        id: string;
        title: string;
        type: string;
        status: string;
        priority: number | null;
        assignee: string | null;
        sprint: string | null;
        release: string | null;
        deadline: string | null;
    };
    blockers: ExplainNeighbor[];
    dependents: ExplainNeighbor[];
    transitiveDependents: string[];
    dependencyDepth: number;
    criticalChainFromItem: string[];
    inCycle: boolean;
    cycleCount: number;
    cycles: string[][];
};
/**
 * Build a focused, agent-friendly report for a single item id:
 * immediate blockers/dependents, transitive impact, depth, critical chain
 * from the item, and cycle participation.
 */
export declare function explainItem(graph: Graph, id: string): ExplainReport | null;
/**
 * Fuzzy-suggest item ids that resemble an operator's input.
 *
 * A candidate survives when it contains the (lowercased) query anywhere, OR
 * shares at least three leading characters with it, so a typo still surfaces
 * the intended id while a one-character clash does not flood the results.
 * Survivors are ranked: exact `startsWith` first, then substring includes, then
 * the longest shared prefix, then alphabetical, and truncated to `limit`.
 * Returns an empty array for a blank query.
 *
 * @param itemIds - Known item ids to search.
 * @param input - The operator's (possibly misspelled) input.
 * @param limit - Maximum suggestions to return.
 * @returns Ranked suggestion ids, possibly empty.
 */
export declare function suggestItemIds(itemIds: string[], input: string, limit?: number): string[];
type ItemIdResolution = {
    input: string;
    resolved: string;
    strategy: "exact" | "case-insensitive" | "prefix";
};
/**
 * Resolve an operator's item-id input to exactly one workspace id.
 *
 * Tries exact match, then a case-insensitive match, then a unique prefix, in
 * that order; an ambiguous case at either fuzzy tier throws an
 * {@link ambiguousItemIdError}, and a total miss throws a `NOT_FOUND` error
 * carrying {@link suggestItemIds} suggestions. The id list is de-duplicated and
 * sorted first so resolution and ambiguity ordering are deterministic.
 *
 * @returns The resolved id and the strategy that matched it.
 * @throws {CommandError} On ambiguity or no match.
 */
export declare function resolveItemIdOrThrow(itemIds: string[], input: string, label: string): ItemIdResolution;
/**
 * Compute a comprehensive offline graph-health report from a shaped graph.
 * All analytics operate on structural edges between item nodes only.
 */
export declare function analyzeGraph(graph: Graph, topN?: number): AnalyzeReport;
/**
 * Collect ALL occurrences of a repeatable string flag (`--flag value` /
 * `--flag=value`). A `null` entry marks an occurrence with a missing value
 * (bare trailing flag, or one followed by another flag) so callers can reject
 * it instead of silently dropping the flag.
 */
export declare function readFlagStringValues(args: string[], longName: string): (string | null)[];
/** Strictly parse a non-negative integer (""/"2abc"/"2.5" are rejected, unlike parseInt). */
export declare function parseNonNegativeInt(raw: unknown): number | undefined;
/**
 * Extension entry point: register the graph commands and output service.
 *
 * Registers an `output_format` service override that unwraps the raw-string
 * marker a `pm-graph export` result carries, so the host renders the document
 * verbatim instead of re-encoding it; the override defers (`{ handled: false }`)
 * for every other command so default rendering is untouched. Then registers
 * each pm-graph command (ping, export, …) against the host API.
 */
export declare function activate(api: ExtensionApi): void;
declare const _default: {
    activate: typeof activate;
};
export default _default;
