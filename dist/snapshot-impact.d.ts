import type { BlockerCutOptions, BlockerCutResult, BlockerCutRefusalCode } from "./blocker-cuts.ts";
import type { Graph } from "./index.ts";
/** Comparison budgets are independent of snapshot capture and host output budgets. */
export type SnapshotImpactOptions = {
    limit?: number;
    offset?: number;
    maxWork?: number;
    cutOptions?: BlockerCutOptions;
};
/** Explanation from the side where a fact existed; text clipping is explicit. */
export type SnapshotNodeContext = {
    id: string;
    title: string;
    status: string;
    textClipped: boolean;
};
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
    missingNode?: {
        id: string;
        before: SnapshotNodeContext | null;
        after: SnapshotNodeContext | null;
    };
    refusal: {
        code: SnapshotImpactRefusalCode;
        remedy: string;
        side?: "before" | "after";
        cutCode?: BlockerCutRefusalCode;
    };
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
        before: {
            nodes: number;
            relationships: number;
        };
        after: {
            nodes: number;
            relationships: number;
        };
        work: number;
        cuts: {
            before: CutReceipt | null;
            after: CutReceipt | null;
        };
        output: {
            total: number;
            returned: number;
            omitted: number;
            offset: number;
            nextOffset: number | null;
            complete: boolean;
        };
    };
};
type CutReceipt = BlockerCutResult["receipt"]["search"];
/** Construct refusals without copying caller data or local filesystem details. */
export declare function snapshotImpactRefusal(code: SnapshotImpactRefusalCode, remedy: string, side?: "before" | "after", cutCode?: BlockerCutRefusalCode): SnapshotImpactRefusal;
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
export declare function compareGraphSnapshots(before: Graph, after: Graph, goal: string, options?: SnapshotImpactOptions): SnapshotImpactResult;
export {};
