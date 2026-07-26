import { type Exporter } from "@unbrained/pm-cli/sdk";
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
export type ExportFormat = "cypher" | "mermaid" | "dot" | "json" | "graphml" | "plantuml";
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
 * path whose first and last ids are equal (e.g. [E, F, E]). Cycles are
 * de-duplicated by their canonical rotation so A->B->A and B->A->B collapse.
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
export type ExplainNeighbor = {
    id: string;
    title: string;
    status: string | null;
    relationTypes: string[];
};
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
 * Compute a comprehensive offline graph-health report from a shaped graph.
 * All analytics operate on structural edges between item nodes only.
 */
export declare function analyzeGraph(graph: Graph, topN?: number): AnalyzeReport;
export declare function activate(api: ExtensionApi): void;
declare const _default: {
    activate: typeof activate;
};
export default _default;
