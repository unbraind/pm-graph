import type { Graph, GraphNode, GraphRelationship } from "./index.ts";
/** Stable refusal categories; checkpoint and sink changes are never published on refusal. */
export type EventProjectionRefusalCode = "INVALID_INPUT" | "FOREIGN_STATE" | "CURSOR_GAP" | "SOURCE_INCOMPLETE" | "SOURCE_BUSY" | "LIMIT" | "SINK_CONFLICT" | "SINK_UNAVAILABLE" | "STORAGE_BUSY";
/** One exact graph entity re-evaluated, whether changed, removed or unchanged. */
export type ProjectionWork = {
    kind: "node";
    id: string;
} | {
    kind: "edge";
    from: string;
    to: string;
    type: string;
};
/** Compact refresh outcome with independently reported source and projection work. */
export type EventProjectionReceipt = {
    ok: boolean;
    exit_code?: number;
    refusal?: {
        code: EventProjectionRefusalCode;
        remedy: string;
    };
    mode?: "admission" | "incremental" | "rebuild";
    reason?: string;
    revision?: string;
    cursor?: string;
    events?: number;
    pages?: number;
    fullScans?: number;
    itemReads?: number;
    eventSources?: string[];
    projectedItems?: number;
    nodes?: number;
    edges?: number;
    evaluatedNodes?: number;
    evaluatedEdges?: number;
    work: ProjectionWork[];
    totalWork?: number;
    nextOffset?: number | null;
};
/** A projection contribution is produced exclusively by the existing graph builder. */
type Contribution = {
    id: string;
    nodes: GraphNode[];
    relationships: GraphRelationship[];
};
/** Owned, bounded checkpoint format; unrelated files are always refused, including on rebuild. */
export type EventProjectionState = {
    owner: "pm-graph/event-projection";
    version: 1;
    source: string;
    revision: string;
    target: string;
    base: string | null;
    receipt: EventProjectionReceipt;
    cursor?: string;
    anchor?: {
        item_id: string;
        version: number;
        hash: string;
    };
    versions: Record<string, number>;
    contributions: Contribution[];
    graph: Graph;
};
/** Native SDK history coordinates committed atomically with a projection revision. */
export type ProjectionSourceHead = {
    cursor?: string;
    anchor?: {
        item_id: string;
        version: number;
        hash: string;
    };
};
/** An owned sink marker; absent sourceHead denotes a compatible pre-recovery marker. */
export type ProjectionSinkPosition = {
    revision: string | null;
    sourceHead?: ProjectionSourceHead;
};
/** Marker inspection precedes planning; apply must revalidate its CAS inside the write transaction. */
export type ProjectionSink = {
    key: string;
    inspect?: (projectKey: string) => Promise<ProjectionSinkPosition | null | "conflict">;
    apply: (change: ProjectionDelta) => Promise<"applied" | "already_applied" | "conflict">;
};
/** Target-revision-bound reconciliation, suitable for an atomic Neo4j transaction. */
export type ProjectionDelta = {
    expected: string | null;
    revision: string;
    projectKey: string;
    sourceHead: ProjectionSourceHead;
    rebuild?: boolean;
    nodes: GraphNode[];
    edges: GraphRelationship[];
    removeNodes: string[];
    removeEdges: GraphRelationship[];
};
/** Explicit storage and output controls; no source-item writes or ambient session defaults. */
export type EventProjectionOptions = {
    pmRoot: string;
    stateFile: string;
    rebuild?: boolean;
    limit?: number;
    offset?: number;
    maxEvents?: number;
    sink?: ProjectionSink;
    /** Diagnostic transition observer; throws simulate interrupted refreshes without bypassing current-state checks. */
    onTransition?: (phase: EventProjectionPhase) => void | Promise<void>;
};
/** Every externally observable storage transition; leases span read through checkpoint publication. */
export declare const EVENT_PROJECTION_PHASES: readonly ["beforeLease", "leased", "read", "anchored", "events", "projected", "caughtUp", "validated", "intent", "beforeSink", "afterSink", "checkpoint", "receipt", "released"];
/** Diagnostic transition identifier for deterministic interleaving tests. */
export type EventProjectionPhase = typeof EVENT_PROJECTION_PHASES[number];
/** Validate checkpoints from disk and emitted checkpoints with one strict schema. */
export declare function validateEventProjection(value: unknown): value is EventProjectionState;
/** Normalize marker producers and consumers through the same strict native-history schema. */
export declare function parseProjectionSourceHead(value: unknown): ProjectionSourceHead | null;
/** Path-free typed failure; callers retain the previously committed projection. */
export declare function eventProjectionRefusal(code: EventProjectionRefusalCode): EventProjectionReceipt;
/** Read and validate a committed offline projection without returning a partially decoded state. */
export declare function readEventProjection(file: string): Promise<EventProjectionState | null>;
/**
 * Refresh a derived projection under one SDK-owned lease. Admission certifies the
 * whole source; catch-up point-reads only changed items, checks stream continuity,
 * and publishes sink changes before an atomic checkpoint. Retry always rereads
 * current source and sink revisions. The source tracker is never mutated.
 */
export declare function refreshEventProjection(options: EventProjectionOptions): Promise<EventProjectionReceipt>;
/** Recover bounded work pages from an atomic checkpoint without invoking source SDK readers. */
export declare function readEventProjectionReceipt(file: string, limit?: number, offset?: number): Promise<EventProjectionReceipt>;
export {};
