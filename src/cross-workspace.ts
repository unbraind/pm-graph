import { certifyCompleteListResult, listAllComplete } from "@unbrained/pm-cli/sdk";
import type { PmCompleteListResult } from "@unbrained/pm-cli/sdk";
import { assertPmTracker, graphFromItems } from "./index.ts";

/** Explicit source capability. Database readers must be bound to the caller's core-authorized tenant scope. */
export type ProjectionSource = { kind: "directory"; pmRoot: string } | { kind: "database"; read: () => Promise<PmCompleteListResult> };
/** Public alias and private source capability; neither paths nor database identifiers enter output. */
export type ProjectionScope = { key: string; source: ProjectionSource };
/** Cross-workspace evidence is opt-in per edge and requires two readable item endpoints. */
export type ProjectionEvidence = {
  from: { workspace: string; item: string };
  to: { workspace: string; item: string };
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
export type ProjectionRow =
  | { kind: "node"; id: string; workspace: string; item: string; title: string; type: string; status: string }
  | { kind: "edge"; from: string; to: string; type: string };
/** Opaque boundary references only the caller's input slot; it carries no source errors or endpoint identities. */
export type ProjectionBoundary = { slot: number; kind: "scope" | "evidence"; code: "CONSENT_REQUIRED" | "UNREADABLE" | "SOURCE_INCOMPLETE" | "ENDPOINT_UNAVAILABLE" | "SOURCE_LIMIT" | "DANGLING_RELATION"; remedy: string };
/** Source completeness and output pagination are independent, explicit receipts. No cross-source atomic snapshot is claimed. */
export type ProjectionResult = {
  ok: boolean;
  exit_code?: number;
  rows: ProjectionRow[];
  boundaries: ProjectionBoundary[];
  complete: boolean;
  receipt: { scopes: number; readable: number; nodes: number; edges: number; total: number; offset: number; returned: number; omitted: number; nextOffset: number | null };
  refusal?: { code: "INVALID_OPTIONS" | "NO_READABLE_SCOPE"; remedy: string };
};

/** Encode each tuple component separately so separators and repeated local IDs cannot collide. */
export function qualifyProjectionId(workspace: string, item: string): string {
  return `${encodeURIComponent(workspace)}::${encodeURIComponent(item)}`;
}

/** Produce a stable, path-free refusal that remains machine-readable through the CLI host. */
export function projectionRefusal(): ProjectionResult {
  return { ok: false, exit_code: 2, rows: [], boundaries: [], complete: false,
    receipt: { scopes: 0, readable: 0, nodes: 0, edges: 0, total: 0, offset: 0, returned: 0, omitted: 0, nextOffset: null },
    refusal: { code: "INVALID_OPTIONS", remedy: "Supply 1-32 unique nonempty scope aliases, explicit consent and an authorization function; limit 1-1000, offset 0 or greater, and at most 10000 typed evidence edges. See project --help." } };
}

/** Check caller-controlled edge shapes without inspecting any source or echoing invalid identities. */
function validEvidence(edge: ProjectionEvidence): boolean {
  return edge !== null && typeof edge === "object" && ["SUPPORTS", "EVIDENCE_FOR"].includes(edge.type)
    && typeof edge.consent === "boolean" && [edge.from, edge.to].every((end) => end !== null && typeof end === "object"
      && typeof end.workspace === "string" && typeof end.item === "string" && end.workspace.length > 0 && end.item.length > 0);
}

/**
 * Project only explicitly consented, currently authorized sources. SDK certificates are
 * revalidated even for database adapters. Failed reads are atomic per source; no partial
 * source rows, dangling identities, source errors, or denied endpoint labels are exposed.
 * Readers run sequentially and without extension hooks; this function performs no writes.
 */
export async function projectWorkspaces(scopes: readonly ProjectionScope[], options: ProjectionOptions): Promise<ProjectionResult> {
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;
  const evidence = options.evidence ?? [];
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 32 || !Array.isArray(options.consent)
    || typeof options.authorize !== "function" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000
    || !Number.isSafeInteger(offset) || offset < 0 || !Array.isArray(evidence) || evidence.length > 10000
    || !evidence.every(validEvidence) || !scopes.every((scope) => scope && typeof scope.key === "string" && scope.key.length > 0 && scope.key.length <= 128
      && scope.source && (scope.source.kind === "directory" ? typeof scope.source.pmRoot === "string" && scope.source.pmRoot.length > 0 : scope.source.kind === "database" && typeof scope.source.read === "function"))
    || new Set(scopes.map((scope) => scope.key)).size !== scopes.length
    || options.consent.some((key) => !scopes.some((scope) => scope.key === key))) return projectionRefusal();
  const rows: ProjectionRow[] = [];
  const boundaries: ProjectionBoundary[] = [];
  const visible = new Set<string>();
  const edgeKeys = new Set<string>();
  let readable = 0;
  for (const [slot, scope] of scopes.entries()) {
    if (!options.consent.includes(scope.key)) {
      boundaries.push({ slot, kind: "scope", code: "CONSENT_REQUIRED", remedy: "Obtain explicit read consent for this input scope." });
      continue;
    }
    let allowed = false;
    try { allowed = await options.authorize(scope) === true; } catch { /* Authorization failures are indistinguishable from denial. */ }
    if (!allowed) {
      boundaries.push({ slot, kind: "scope", code: "UNREADABLE", remedy: "Ask the source owner to grant read access, then retry with current authorization." });
      continue;
    }
    let snapshot: PmCompleteListResult;
    try {
      snapshot = certifyCompleteListResult(scope.source.kind === "directory"
        ? await listAllComplete({}, { pmRoot: assertPmTracker(scope.source.pmRoot), noExtensions: true }) : await scope.source.read());
    } catch {
      boundaries.push({ slot, kind: "scope", code: "SOURCE_INCOMPLETE", remedy: "Restore a readable source and use the SDK listAllComplete reader without filters or output limits." });
      continue;
    }
    if (snapshot.items.length > 100000) {
      boundaries.push({ slot, kind: "scope", code: "SOURCE_LIMIT", remedy: "Project a separately authorized tracker containing at most 100000 items." });
      continue;
    }
    const graph = graphFromItems(snapshot.items, scope.key, new Map());
    const local = new Set(snapshot.items.map((item) => item.id));
    for (const item of snapshot.items) {
      const id = qualifyProjectionId(scope.key, item.id);
      visible.add(id);
      rows.push({ kind: "node", id, workspace: scope.key, item: item.id, title: item.title, type: item.type, status: item.status });
    }
    const external = new Set(graph.nodes.filter((node) => node.labels.includes("ExternalPmItem")).map((node) => node.id));
    let dangling = false;
    for (const edge of graph.relationships) {
      if (!local.has(edge.from) || !local.has(edge.to)) {
        if (external.has(edge.to)) dangling = true;
        continue;
      }
      const from = qualifyProjectionId(scope.key, edge.from);
      const to = qualifyProjectionId(scope.key, edge.to);
      rows.push({ kind: "edge", from, to, type: edge.type });
      edgeKeys.add(JSON.stringify([from, to, edge.type]));
    }
    if (dangling) boundaries.push({ slot, kind: "scope", code: "DANGLING_RELATION", remedy: "Resolve missing local relationships in the source; cross-workspace evidence requires a separate consented edge." });
    readable++;
  }
  for (const [slot, edge] of evidence.entries()) {
    if (!edge.consent) {
      boundaries.push({ slot, kind: "evidence", code: "CONSENT_REQUIRED", remedy: "Obtain explicit consent for this evidence edge." });
      continue;
    }
    const from = qualifyProjectionId(edge.from.workspace, edge.from.item);
    const to = qualifyProjectionId(edge.to.workspace, edge.to.item);
    if (!visible.has(from) || !visible.has(to)) {
      boundaries.push({ slot, kind: "evidence", code: "ENDPOINT_UNAVAILABLE", remedy: "Ensure both endpoints are in readable consented sources; no boundary is traversed automatically." });
      continue;
    }
    const key = JSON.stringify([from, to, edge.type]);
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    rows.push({ kind: "edge", from, to, type: edge.type });
  }
  const page = rows.slice(offset, offset + limit);
  const nodes = visible.size;
  const nextOffset = offset + page.length < rows.length ? offset + page.length : null;
  return { ok: readable > 0, rows: page, boundaries,
    complete: boundaries.length === 0,
    receipt: { scopes: scopes.length, readable, nodes, edges: rows.length - nodes, total: rows.length, offset, returned: page.length, omitted: rows.length - page.length, nextOffset },
    ...(readable === 0 ? { exit_code: 2, refusal: { code: "NO_READABLE_SCOPE" as const, remedy: "Provide at least one consented source with current read authorization and a certified complete read." } } : {}) };
}
