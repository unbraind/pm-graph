import type { Graph } from "./index.ts";
/** Exact, stored directed arrows; costs are per item read, inclusive of both endpoints. */
export interface EvidencePathInput {
    nodes: {
        id: string;
        unknown?: boolean;
    }[];
    edges: {
        from: string;
        to: string;
        type: string;
    }[];
    from: string;
    to: string;
    edgeTypes: string[];
    /** Nonnegative integer units, <=1e9 each. Missing rows and null mean unknown. */
    costs: {
        id: string;
        cost: number | null;
    }[];
    /** Each cost search may settle 1-10000 nodes (default 10000). */
    maxSettled?: number;
    /** Each cost search may perform 1-1000000 queue pops/edge visits (default 100000). */
    maxWork?: number;
    /** Atomic output bound per witness, 1-1000 nodes (default 128). */
    maxPathNodes?: number;
}
/** Compact witness includes original edge types and all unknown item costs. */
export interface EvidencePathWitness {
    kind: "evidence-cost" | "shortest-hop";
    path: string[];
    edges: string[];
    hops: number;
    cost: number | null;
    knownCost: number;
    unknown: string[];
}
/** Search bounds describe actual work; a frontier bound never asserts a finished search. */
export interface EvidencePathSearch {
    settled: number;
    work: number;
    stop: "goal" | "exhausted" | "maxSettled" | "maxWork";
    lowerBound: number | null;
}
/** Typed failures carry remedies without echoing paths, item contents or file contents. */
export type EvidencePathRefusalCode = "INVALID_INPUT" | "UNKNOWN_ENDPOINT" | "SOURCE_INCOMPLETE" | "OUTPUT_LIMIT" | "INPUT_UNAVAILABLE" | "CONTRACT_VIOLATION";
/** Cost optimality is independent of shortest-hop topology and source certification. */
export type EvidencePathResult = {
    ok: true;
    contract: "declared-item-read-cost-v1";
    reachable: boolean;
    optimality: "proved" | "unknown-costs" | "search-limited" | "no-path";
    rows: EvidencePathWitness[];
    receipt: {
        nodes: number;
        edges: number;
        unknownCosts: number;
        shortest: {
            visitedNodes: number;
            inspectedEdges: number;
        };
        known: EvidencePathSearch;
        optimistic: EvidencePathSearch;
    };
} | {
    ok: false;
    exit_code: 2;
    rows: [];
    refusal: {
        code: EvidencePathRefusalCode;
        remedy: string;
    };
};
/** One refusal contract for the SDK, CLI file reader and source acquisition. */
export declare function evidencePathRefusal(code: EvidencePathRefusalCode, remedy: string): EvidencePathResult;
/** Adapt package projections without exposing metadata or inferring a cost from content. */
export declare function evidencePathInputFromGraph(graph: Graph, options: Omit<EvidencePathInput, "nodes" | "edges">): EvidencePathInput;
/** Rank valid directed witnesses by additive declared item-read cost, with truthful bounded proofs. */
export declare function explainEvidencePath(input: EvidencePathInput): EvidencePathResult;
