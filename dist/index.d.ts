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
