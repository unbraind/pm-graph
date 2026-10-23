import type { PmCompleteListResult } from "@unbrained/pm-cli/sdk";
/** Explicit source capability. Database readers must be bound to the caller's core-authorized tenant scope. */
export type ProjectionSource = {
    kind: "directory";
    pmRoot: string;
} | {
    kind: "database";
    read: () => Promise<PmCompleteListResult>;
};
/** Public alias and private source capability; neither paths nor database identifiers enter output. */
export type ProjectionScope = {
    key: string;
    source: ProjectionSource;
};
/** Cross-workspace evidence is opt-in per edge and requires two readable item endpoints. */
export type ProjectionEvidence = {
    from: {
        workspace: string;
        item: string;
    };
    to: {
        workspace: string;
        item: string;
    };
    type: "SUPPORTS" | "EVIDENCE_FOR";
    consent: boolean;
};
/** Explicit consent plus the host's current authorization policy; consent never overrides denial. */
export type ProjectionOptions = {
    consent: readonly string[];
    authorize: (scope: ProjectionScope) => boolean | Promise<boolean>;
    evidence?: readonly ProjectionEvidence[];
    limit?: number;
    offset?: number;
};
/** Compact item-only graph rows, intentionally excluding bodies, raw dependencies and external placeholders. */
export type ProjectionRow = {
    kind: "node";
    id: string;
    workspace: string;
    item: string;
    title: string;
    type: string;
    status: string;
} | {
    kind: "edge";
    from: string;
    to: string;
    type: string;
};
/** Opaque boundary references only the caller's input slot; it carries no source errors or endpoint identities. */
export type ProjectionBoundary = {
    slot: number;
    kind: "scope" | "evidence";
    code: "CONSENT_REQUIRED" | "UNREADABLE" | "SOURCE_INCOMPLETE" | "ENDPOINT_UNAVAILABLE" | "SOURCE_LIMIT" | "DANGLING_RELATION";
    remedy: string;
};
/** Source completeness and output pagination are independent, explicit receipts. No cross-source atomic snapshot is claimed. */
export type ProjectionResult = {
    ok: boolean;
    exit_code?: number;
    rows: ProjectionRow[];
    boundaries: ProjectionBoundary[];
    complete: boolean;
    receipt: {
        scopes: number;
        readable: number;
        nodes: number;
        edges: number;
        total: number;
        offset: number;
        returned: number;
        omitted: number;
        nextOffset: number | null;
    };
    refusal?: {
        code: "INVALID_OPTIONS" | "NO_READABLE_SCOPE";
        remedy: string;
    };
};
/** Encode each tuple component separately so separators and repeated local IDs cannot collide. */
export declare function qualifyProjectionId(workspace: string, item: string): string;
/** Produce a stable, path-free refusal that remains machine-readable through the CLI host. */
export declare function projectionRefusal(): ProjectionResult;
/**
 * Project only explicitly consented, currently authorized sources. SDK certificates are
 * revalidated even for database adapters. Failed reads are atomic per source; no partial
 * source rows, dangling identities, source errors, or denied endpoint labels are exposed.
 * Readers run sequentially and without extension hooks; this function performs no writes.
 */
export declare function projectWorkspaces(scopes: readonly ProjectionScope[], options: ProjectionOptions): Promise<ProjectionResult>;
