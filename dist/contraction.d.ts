import type { Graph } from "./index.ts";
/** Minimal directed view: metadata and status filtering belong to the source SDK projection. */
export type ContractionInput = {
    nodes: {
        id: string;
        unknown?: boolean;
    }[];
    edges: {
        from: string;
        to: string;
        type: string;
    }[];
    boundary: string[];
    edgeTypes: string[];
    limit?: number;
    offset?: number;
    /** Return only membership rows for this summary id, with ordinary pagination. */
    expand?: string;
};
/** Adapt the existing SDK-backed package projection without copying tracker metadata into output. */
export declare function contractionInputFromGraph(graph: Graph, boundary: string[], edgeTypes: string[]): ContractionInput;
/** Original identities and evidence remain distinct from the summary-id namespace. */
export type ContractionRow = {
    kind: "group";
    id: string;
    members: string[];
    incoming: string[];
    outgoing: string[];
    cyclic: boolean;
    unknown: boolean;
} | {
    kind: "edge";
    from: string;
    to: string;
    type: string;
    count: number;
    witness: [string, string];
} | {
    kind: "answer";
    from: string;
    to: string;
    reachable: boolean;
    witness: string[];
    types: string[];
} | {
    kind: "cycle";
    members: string[];
} | {
    kind: "member";
    group: string;
    id: string;
};
/** Refusals are atomic: no partial projection is returned as a successful answer. */
export type ContractionRefusalCode = "INVALID_INPUT" | "WORK_LIMIT" | "UNKNOWN_BOUNDARY" | "UNKNOWN_GROUP" | "CONTRACT_VIOLATION" | "SOURCE_INCOMPLETE";
/** Complete source counts and independent, recoverable output pagination. */
export type ContractionReceipt = {
    nodes: number;
    edges: number;
    groups: number;
    summaryEdges: number;
    boundaryPairs: number;
    cycles: number;
    unknown: number;
    reduction: number;
    total: number;
    offset: number;
    returned: number;
    omitted: number;
    nextOffset: number | null;
};
/** Successful answers certify every selected pair even when output rows are paginated. */
export type ContractionResult = {
    ok: true;
    contract: "stored-directed-reachability-v1";
    rows: ContractionRow[];
    receipt: ContractionReceipt;
} | {
    ok: false;
    exit_code: 2;
    rows: [];
    refusal: {
        code: ContractionRefusalCode;
        remedy: string;
    };
};
/** Produce a path-free structured refusal usable by SDK and CLI callers. */
export declare function contractionRefusal(code: ContractionRefusalCode, remedy: string): ContractionResult;
/**
 * Collapse equal inbound/outbound boundary signatures, preserving original SCCs and
 * unknown endpoints as singleton groups. All ordered boundary pairs are checked on
 * the quotient before success; witnesses always come from the original SDK index.
 * The result is a read-only explanation view, not a lossless tracker serialization.
 */
export declare function contractGraph(input: ContractionInput): ContractionResult;
