import type { Exporter } from "@unbrained/pm-cli/sdk";
type CommandContext = {
    command?: string;
    args?: string[];
    cwd?: string;
    workspaceRoot?: string;
};
type RegisterCommand = {
    name: string;
    description: string;
    run: (context: CommandContext) => Promise<unknown>;
};
type ExtensionApi = {
    registerCommand(command: RegisterCommand): void;
    registerExporter(name: string, exporter: Exporter): void;
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
export type ExportFormat = "cypher" | "mermaid" | "dot" | "json" | "graphml" | "plantuml";
export type EdgeFilter = "deps" | "tags" | "all";
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
 * Compute a comprehensive offline graph-health report from a shaped graph.
 * All analytics operate on structural edges between item nodes only.
 */
export declare function analyzeGraph(graph: Graph, topN?: number): AnalyzeReport;
export declare function activate(api: ExtensionApi): void;
declare const _default: {
    activate: typeof activate;
};
export default _default;
