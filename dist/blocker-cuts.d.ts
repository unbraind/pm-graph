import type { Graph } from "./index.ts";
/** Deterministic limits; input size is capped and enumeration is work-budgeted. */
export type BlockerCutOptions = {
    maxStates?: number;
    maxWork?: number;
    maxCuts?: number;
    maxSize?: number;
    /** Terminal statuses stop traversal; custom registries can supply their own sets. */
    resolvedStatuses?: readonly string[];
    /** Missing/unrecognized statuses refuse a proof instead of guessing actionability. */
    unresolvedStatuses?: readonly string[];
};
/** One inclusion-minimal vertex separator, sorted by id. */
export type BlockerCut = {
    blockers: string[];
    /** True only if resolving this set also satisfies every immediate prerequisite. */
    immediatelyUnblocked: boolean;
};
/** Independent receipts for the supplied graph and the bounded enumeration. */
export type BlockerCutReceipt = {
    graph: {
        scope: "supplied-snapshot";
        edgePolicy: "BLOCKED_BY|DEPENDS_ON|REQUIRES|reverse:BLOCKS";
        nodes: number;
        relationships: number;
        reachableUnresolved: number;
        complete: boolean;
        unknownNodes: string[];
        unknownNodeCount: number;
        unknownStatuses: string[];
        unknownStatusCount: number;
        cycle: string[];
    };
    search: {
        complete: boolean;
        reason: "exhausted" | "maxStates" | "maxWork" | "maxCuts" | "maxSize" | "refused";
        states: number;
        work: number;
        completeThroughSize: number;
        minimumCardinality: number | null;
        limits: {
            maxStates: number;
            maxWork: number;
            maxCuts: number;
            maxSize: number;
        };
    };
};
/** Stable refusal codes with actionable remedies, usable by a graph view without parsing text. */
export type BlockerCutRefusalCode = "INVALID_OPTIONS" | "GRAPH_LIMIT" | "INVALID_GRAPH" | "UNKNOWN_GOAL" | "INCOMPLETE_GRAPH" | "CYCLE";
/** Compact result: frontier cuts describe plans, not automatic completion of intervening work. */
export type BlockerCutResult = {
    ok: true;
    goal: string;
    semantics: "upstream-frontier";
    goalResolved: boolean;
    immediateBlockers: string[];
    cuts: BlockerCut[];
    receipt: BlockerCutReceipt;
} | {
    ok: false;
    goal: string;
    refusal: {
        code: BlockerCutRefusalCode;
        remedy: string;
    };
    receipt: BlockerCutReceipt;
};
/**
 * Enumerate inclusion-minimal unresolved vertex cuts between a goal and its
 * upstream unresolved leaves. Every prerequisite is conjunctive. Resolving a
 * frontier clears all upstream blocking paths; intermediate work still needs
 * completion. `immediatelyUnblocked` distinguishes direct eligibility.
 *
 * Only BLOCKED_BY, DEPENDS_ON, REQUIRES and reversed BLOCKS edges are gating;
 * hierarchy, facets and RELATED edges never imply prerequisites. Resolved
 * nodes stop traversal. Cycles, dangling prerequisites and unknown statuses in
 * the active goal cone refuse a proof. Completeness covers the supplied
 * snapshot only; callers must separately certify their source read.
 *
 * Cardinality-ordered combination search proves minimality before emitting a
 * cut, including when truncated. Work counts visited vertices/edges and subset
 * comparisons; hard caps bound both output and exponential search. Preflight
 * scans at most 100,000 nodes and 500,000 relationships; the active cone is
 * limited to 512 unresolved vertices. No filesystem, git or service access.
 */
export declare function minimalBlockerCuts(graph: Graph, goal: string, options?: BlockerCutOptions): BlockerCutResult;
