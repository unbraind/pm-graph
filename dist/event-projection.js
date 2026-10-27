import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import { open, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { graphFromItems } from "./index.js";
/** Lazy supported package-export resolution, independent of executable paths and symlinks. */
const requireSdk = createRequire(import.meta.url);
/** Acquire the supported SDK only when projection storage is used. */
function sdk() { return requireSdk("@unbrained/pm-cli/sdk"); }
/** Every externally observable storage transition; leases span read through checkpoint publication. */
export const EVENT_PROJECTION_PHASES = ["beforeLease", "leased", "read", "anchored", "events", "projected", "caughtUp", "validated", "beforeSink", "afterSink", "checkpoint", "released"];
const MAX = 100000;
const MAX_BYTES = 128 * 1024 * 1024;
/** Strict JSON domain shared by checkpoint producers and consumers: finite, dense and bounded. */
function jsonDomain(value, depth = 0) {
    if (depth > 24)
        return false;
    if (value === null || typeof value === "boolean")
        return true;
    if (typeof value === "number")
        return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
    if (typeof value === "string")
        return value.length <= 65536;
    if (Array.isArray(value)) {
        if (value.length > MAX * 20 || Object.keys(value).length !== value.length)
            return false;
        for (let i = 0; i < value.length; i++)
            if (!jsonDomain(value[i], depth + 1))
                return false;
        return true;
    }
    return typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
        && Object.keys(value).length <= MAX && Object.entries(value).every(([key, entry]) => key.length <= 512 && (entry === undefined || jsonDomain(entry, depth + 1)));
}
/** Exact object shape, rejecting unknown transport keys rather than silently ignoring them. */
function keys(value, required, optional = []) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => [...required, ...optional].includes(key));
}
/** Validate a graph row using the same bounded JSON domain as emitted checkpoints. */
function node(value) {
    return keys(value, ["id", "labels", "properties"]) && typeof value.id === "string" && value.id.length > 0
        && Array.isArray(value.labels) && value.labels.every((label) => typeof label === "string")
        && keys(value.properties, Object.keys(value.properties ?? {}));
}
/** Validate one edge without accepting Cypher identifiers supplied by an untrusted checkpoint. */
function edge(value) {
    return keys(value, ["from", "to", "type", "properties"]) && [value.from, value.to].every((id) => typeof id === "string" && id.length > 0)
        && typeof value.type === "string" && /^[A-Z0-9_]+$/.test(value.type) && keys(value.properties, Object.keys(value.properties ?? {}));
}
/** Hash a revision's complete payload, retaining its predecessor so replay identity is revision-bound. */
function hash(value) { return createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex"); }
/** Validate checkpoints from disk and emitted checkpoints with one strict schema. */
export function validateEventProjection(value) {
    if (!jsonDomain(value) || !keys(value, ["owner", "version", "source", "revision", "target", "base", "receipt", "versions", "contributions", "graph"], ["cursor", "anchor"]))
        return false;
    const s = value;
    if (typeof s.target !== "string" || s.target.length < 1 || s.target.length > 128 || (s.base !== null && (typeof s.base !== "string" || !/^[a-f0-9]{64}$/.test(s.base))) || !validReceipt(s.receipt) || s.owner !== "pm-graph/event-projection" || s.version !== 1 || !/^[a-f0-9]{64}$/.test(s.source) || !/^[a-f0-9]{64}$/.test(s.revision)
        || (s.cursor !== undefined && (typeof s.cursor !== "string" || s.cursor.length > 4096))
        || !keys(s.versions, Object.keys(s.versions ?? {})) || !Object.values(s.versions).every((v) => Number.isSafeInteger(v) && v > 0)
        || !Array.isArray(s.contributions) || s.contributions.length > MAX || !s.contributions.every((c) => keys(c, ["id", "nodes", "relationships"])
        && typeof c.id === "string" && Array.isArray(c.nodes) && c.nodes.every(node) && Array.isArray(c.relationships) && c.relationships.every(edge))
        || new Set(s.contributions.map((c) => c.id)).size !== s.contributions.length
        || !keys(s.graph, ["generatedAt", "workspace", "projectKey", "nodes", "relationships"])
        || typeof s.graph.generatedAt !== "string" || !Number.isFinite(Date.parse(s.graph.generatedAt)) || s.graph.workspace !== "projection" || s.graph.projectKey !== "projection"
        || !Array.isArray(s.graph.nodes) || !s.graph.nodes.every(node) || !Array.isArray(s.graph.relationships) || !s.graph.relationships.every(edge))
        return false;
    if (s.anchor !== undefined && (!keys(s.anchor, ["item_id", "version", "hash"])
        || typeof s.anchor.item_id !== "string" || typeof s.anchor.hash !== "string" || !/^[a-f0-9]{64}$/.test(s.anchor.hash) || !Number.isSafeInteger(s.anchor.version) || s.anchor.version < 1))
        return false;
    return s.receipt.revision === s.revision && s.receipt.cursor === s.cursor
        && s.receipt.nodes === s.graph.nodes.length && s.receipt.edges === s.graph.relationships.length
        && s.receipt.totalWork === Number(s.receipt.evaluatedNodes) + Number(s.receipt.evaluatedEdges)
        && (s.cursor === undefined) === (s.anchor === undefined) && s.revision === stateRevision(s);
}
/** Validate every emitted counter with the same bounded schema used for checkpoint receipts. */
function validReceipt(value) {
    return keys(value, ["ok", "mode", "reason", "revision", "events", "pages", "fullScans", "itemReads", "eventSources", "projectedItems", "nodes", "edges", "evaluatedNodes", "evaluatedEdges", "work", "totalWork", "nextOffset"], ["cursor"])
        && value.ok === true && typeof value.reason === "string" && typeof value.revision === "string"
        && Array.isArray(value.eventSources) && value.eventSources.every((source) => source === "derived_index" || source === "authoritative_history") && ["admission", "incremental", "rebuild"].includes(String(value.mode))
        && ["events", "pages", "fullScans", "itemReads", "projectedItems", "nodes", "edges", "evaluatedNodes", "evaluatedEdges", "totalWork"].every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
        && value.nextOffset === null && Array.isArray(value.work) && value.work.length === value.totalWork
        && value.work.every((w) => keys(w, ["kind", "id"]) && w.kind === "node" && typeof w.id === "string"
            || keys(w, ["kind", "from", "to", "type"]) && w.kind === "edge" && [w.from, w.to, w.type].every((v) => typeof v === "string"));
}
/** Revision identity binds content, source and predecessor; graph timestamps do not affect safe retries. */
function stateRevision(s) {
    return hash({ base: s.base, target: s.target, source: s.source, cursor: s.cursor, contributions: s.contributions, graph: { nodes: s.graph.nodes, relationships: s.graph.relationships }, versions: s.versions });
}
/** Build a stable identity for an edge without delimiter collisions. */
function edgeKey(e) { return JSON.stringify([e.from, e.to, e.type]); }
/** Path-free typed failure; callers retain the previously committed projection. */
export function eventProjectionRefusal(code) {
    const remedies = {
        INVALID_INPUT: "Use explicit tracker and checkpoint paths, limit 1-1000, nonnegative offset, maxEvents 1-1000000 and a valid owned checkpoint.",
        FOREIGN_STATE: "Choose a new checkpoint file; this path contains foreign or invalid data and will not be overwritten.",
        CURSOR_GAP: "History continuity is unavailable. Retry with --rebuild to admit a new certified complete source.",
        SOURCE_INCOMPLETE: "Restore readable authoritative items/history; obtain SDK listAllComplete certification before retrying.",
        SOURCE_BUSY: "Source changed during refresh; retry. No checkpoint was advanced.",
        LIMIT: "Increase maxEvents within 1000000 or use a smaller separately managed tracker; no partial refresh was committed.",
        SINK_UNAVAILABLE: "Restore the configured sink connection and write/schema permissions, then retry the same checkpoint.",
        SINK_CONFLICT: "Reconcile the sink's current revision with this checkpoint; never replay a frozen plan over another writer.",
        STORAGE_BUSY: "Another refresher owns storage or storage is unavailable; retry after it completes.",
    };
    return { ok: false, exit_code: 2, refusal: { code, remedy: remedies[code] }, work: [] };
}
/** Read one bounded regular checkpoint, without blocking on FIFOs or following symbolic links. */
async function readState(file) {
    let handle;
    try {
        handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_BYTES)
            return false;
        return JSON.parse(await handle.readFile("utf8"));
    }
    catch {
        return false;
    }
    finally {
        await handle.close();
    }
}
/** Read and validate a committed offline projection without returning a partially decoded state. */
export async function readEventProjection(file) {
    const value = await readState(file);
    return validateEventProjection(value) ? value : null;
}
/** Read pages through the SDK, preserving opaque cursors and refusing bounded partial catch-up. */
async function events(pmRoot, since, maxEvents) {
    const rows = [];
    let cursor = since;
    let pages = 0;
    const sources = new Set();
    let page;
    do {
        page = await sdk().listMutationEvents({ pmRoot, since: cursor, limit: 1000, cursorMode: "batch", full: true });
        pages++;
        sources.add(page.source);
        rows.push(...page.events);
        if (rows.length > maxEvents || (page.has_more && !page.next_cursor))
            throw new Error("LIMIT");
        cursor = page.next_cursor ?? cursor;
    } while (page.has_more);
    return { rows, cursor, pages, sources: [...sources], anchor: rows.at(-1) };
}
/** Use the SDK's exact item reader, including configured schemas, without child/corpus scans. */
async function item(pmRoot, id) {
    const settings = await sdk().readSettings(pmRoot);
    const registry = sdk().resolveItemTypeRegistry(settings);
    const located = await sdk().locateItem(pmRoot, id, undefined, settings.item_format, registry.type_to_folder);
    return located ? (await sdk().readLocatedItem(located, { schema: settings.schema })).document.metadata : null;
}
/** Project a single authoritative SDK item using the package's existing producer. */
function contribution(value) {
    const graph = graphFromItems([value], "projection", new Map());
    if (!jsonDomain(graph))
        throw new Error("Invalid graph producer output");
    return JSON.parse(JSON.stringify({ id: value.id, nodes: graph.nodes, relationships: graph.relationships }));
}
/** Materialize cached contributions; canonical owner order makes facet collision precedence deterministic. */
function materialize(contributions) {
    const nodes = new Map();
    const relationships = [];
    for (const c of contributions)
        for (const n of c.nodes) {
            const previous = nodes.get(n.id);
            if (!previous || previous.labels.includes("ExternalPmItem"))
                nodes.set(n.id, n);
        }
    for (const c of contributions)
        relationships.push(...c.relationships);
    return { generatedAt: new Date().toISOString(), workspace: "projection", projectKey: "projection", nodes: [...nodes.values()], relationships };
}
/** Validate options exactly once, before SDK reads, leases or sink calls. */
function validOptions(o) {
    return keys(o, ["pmRoot", "stateFile"], ["rebuild", "limit", "offset", "maxEvents", "sink", "onTransition"])
        && [o.pmRoot, o.stateFile].every((s) => typeof s === "string" && s.length > 0 && s.length <= 4096)
        && (o.rebuild === undefined || typeof o.rebuild === "boolean")
        && Number.isSafeInteger(o.limit ?? 100) && (o.limit ?? 100) >= 1 && (o.limit ?? 100) <= 1000
        && Number.isSafeInteger(o.offset ?? 0) && (o.offset ?? 0) >= 0
        && Number.isSafeInteger(o.maxEvents ?? MAX * 10) && (o.maxEvents ?? MAX * 10) >= 1 && (o.maxEvents ?? MAX * 10) <= MAX * 10
        && (o.onTransition === undefined || typeof o.onTransition === "function")
        && (o.sink === undefined || (o.sink !== null && typeof o.sink.key === "string" && o.sink.key.length > 0 && o.sink.key.length <= 128 && typeof o.sink.apply === "function"));
}
/**
 * Refresh a derived projection under one SDK-owned lease. Admission certifies the
 * whole source; catch-up point-reads only changed items, checks stream continuity,
 * and publishes sink changes before an atomic checkpoint. Retry always rereads
 * current source and sink revisions. The source tracker is never mutated.
 */
export async function refreshEventProjection(options) {
    if (!validOptions(options))
        return eventProjectionRefusal("INVALID_INPUT");
    const pmRoot = options.pmRoot;
    let stateFile = options.stateFile;
    let release;
    let applyingSink = false;
    try {
        await options.onTransition?.("beforeLease");
        await mkdir(path.dirname(stateFile), { recursive: true });
        stateFile = path.join(await realpath(path.dirname(stateFile)), path.basename(stateFile));
        release = await sdk().acquireLock(path.dirname(stateFile), `graph-${hash(path.resolve(stateFile))}`, 3600, "pm-graph-projection", false, true, 0, { maxWaitMs: 0 });
        await options.onTransition?.("leased");
        const raw = await readState(stateFile);
        await options.onTransition?.("read");
        if (raw !== null && !validateEventProjection(raw))
            return eventProjectionRefusal("FOREIGN_STATE");
        const previous = raw;
        const source = hash(await realpath(pmRoot));
        if (previous && previous.source !== source)
            return eventProjectionRefusal("FOREIGN_STATE");
        const target = options.sink?.key ?? "offline";
        if (previous && previous.target !== target)
            return eventProjectionRefusal("SINK_CONFLICT");
        const rebuild = !previous || options.rebuild === true;
        const mode = !previous ? "admission" : rebuild ? "rebuild" : "incremental";
        if (!rebuild && previous.anchor) {
            const history = await sdk().readHistoryEntries(sdk().getHistoryPath(pmRoot, previous.anchor.item_id), previous.anchor.item_id);
            const anchor = history[previous.anchor.version - 1];
            if (!anchor || hash(anchor) !== previous.anchor.hash)
                return eventProjectionRefusal("CURSOR_GAP");
        }
        await options.onTransition?.("anchored");
        const batch = await events(pmRoot, rebuild ? undefined : previous?.cursor, options.maxEvents ?? MAX * 10);
        await options.onTransition?.("events");
        const versions = rebuild ? {} : { ...previous.versions };
        const changed = new Set();
        for (const event of batch.rows) {
            if (!rebuild && event.version !== (versions[event.item_id] ?? 0) + 1)
                return eventProjectionRefusal("CURSOR_GAP");
            versions[event.item_id] = event.version;
            changed.add(event.item_id);
        }
        if (!rebuild && changed.has("_workspace"))
            return eventProjectionRefusal("CURSOR_GAP");
        if (!rebuild && batch.rows.length === 0) {
            applyingSink = true;
            if (options.sink && await options.sink.apply({ expected: previous.revision, revision: previous.revision, projectKey: source, nodes: [], edges: [], removeNodes: [], removeEdges: [] }) === "conflict")
                return eventProjectionRefusal("SINK_CONFLICT");
            return { ...previous.receipt, mode: "incremental", reason: "SDK mutation catch-up", events: 0, pages: batch.pages, fullScans: 0, itemReads: 0, projectedItems: 0, evaluatedNodes: 0, evaluatedEdges: 0, work: [], totalWork: 0, nextOffset: null, eventSources: batch.sources };
        }
        let contributions;
        let itemReads = 0;
        if (rebuild) {
            const snapshot = sdk().certifyCompleteListResult(await sdk().listAllComplete({}, { pmRoot, noExtensions: true }));
            if (snapshot.items.length > MAX)
                return eventProjectionRefusal("LIMIT");
            contributions = snapshot.items.map(contribution);
            itemReads = snapshot.items.length;
        }
        else {
            const byId = new Map(previous.contributions.map((c) => [c.id, c]));
            for (const id of changed) {
                const current = await item(pmRoot, id);
                itemReads++;
                if (current)
                    byId.set(id, contribution(current));
                else {
                    if (!batch.rows.some((event) => event.item_id === id && event.type === "delete"))
                        return eventProjectionRefusal("SOURCE_INCOMPLETE");
                    byId.delete(id);
                }
            }
            contributions = [...byId.values()];
        }
        await options.onTransition?.("projected");
        const tail = await events(pmRoot, batch.cursor, options.maxEvents ?? MAX * 10);
        if (tail.rows.length)
            return eventProjectionRefusal("SOURCE_BUSY");
        await options.onTransition?.("caughtUp");
        contributions.sort((a, b) => a.id.localeCompare(b.id));
        const graph = materialize(contributions);
        const cursor = batch.cursor;
        const anchor = batch.anchor ? { item_id: batch.anchor.item_id, version: batch.anchor.version, hash: hash(batch.anchor.entry) } : previous?.anchor;
        const revision = stateRevision({ target, base: previous?.revision ?? null, source, cursor, contributions, graph, versions });
        const evaluated = rebuild ? [...(previous?.contributions ?? []), ...contributions] : [...previous.contributions.filter((c) => changed.has(c.id)), ...contributions.filter((c) => changed.has(c.id))];
        const workNodes = new Set(evaluated.flatMap((c) => c.nodes.map((n) => n.id)));
        const workEdges = new Map(evaluated.flatMap((c) => c.relationships.map((e) => [edgeKey(e), e])));
        const oldNodes = new Map(previous?.graph.nodes.map((n) => [n.id, n]) ?? []);
        const oldEdges = new Map(previous?.graph.relationships.map((e) => [edgeKey(e), e]) ?? []);
        const newNodes = new Map(graph.nodes.map((n) => [n.id, n]));
        const newEdges = new Map(graph.relationships.map((e) => [edgeKey(e), e]));
        const work = [...[...workNodes].sort().map((id) => ({ kind: "node", id })), ...[...workEdges.values()].map(({ from, to, type }) => ({ kind: "edge", from, to, type }))];
        const receipt = { ok: true, mode, reason: mode === "rebuild" ? "explicit certified rebuild" : mode === "admission" ? "initial certified admission" : "SDK mutation catch-up",
            revision, ...(cursor ? { cursor } : {}), events: batch.rows.length, pages: batch.pages + tail.pages, fullScans: rebuild ? 1 : 0, itemReads,
            eventSources: [...new Set([...batch.sources, ...tail.sources])], projectedItems: rebuild ? contributions.length : changed.size, nodes: graph.nodes.length, edges: graph.relationships.length,
            evaluatedNodes: workNodes.size, evaluatedEdges: workEdges.size, work, totalWork: work.length, nextOffset: null };
        const state = { owner: "pm-graph/event-projection", version: 1, source, revision, target, base: previous?.revision ?? null, receipt, versions, contributions, graph,
            ...(cursor ? { cursor } : {}), ...(anchor ? { anchor } : {}) };
        if (!validateEventProjection(state))
            return eventProjectionRefusal("SOURCE_INCOMPLETE");
        const encoded = JSON.stringify(state);
        if (Buffer.byteLength(encoded) > MAX_BYTES)
            return eventProjectionRefusal("LIMIT");
        await options.onTransition?.("validated");
        await options.onTransition?.("beforeSink");
        if (options.sink) {
            applyingSink = true;
            const delta = { expected: previous?.revision ?? null, revision, projectKey: source,
                nodes: graph.nodes.filter((n) => hash(n) !== hash(oldNodes.get(n.id))), edges: graph.relationships.filter((e) => hash(e) !== hash(oldEdges.get(edgeKey(e)))),
                removeNodes: [...oldNodes.keys()].filter((id) => !newNodes.has(id)), removeEdges: [...oldEdges.values()].filter((e) => !newEdges.has(edgeKey(e))) };
            if (await options.sink.apply(delta) === "conflict")
                return eventProjectionRefusal("SINK_CONFLICT");
        }
        applyingSink = false;
        await options.onTransition?.("afterSink");
        await sdk().writeFileAtomic(stateFile, encoded);
        await options.onTransition?.("checkpoint");
        return pageReceipt(receipt, options.limit ?? 100, options.offset ?? 0);
    }
    catch (error) {
        if (error instanceof Error && error.message === "LIMIT")
            return eventProjectionRefusal("LIMIT");
        if (applyingSink)
            return eventProjectionRefusal("SINK_UNAVAILABLE");
        if (error !== null && typeof error === "object" && "code" in error && ["invalid_event_cursor", "event_cursor_query_mismatch"].includes(String(error.code)))
            return eventProjectionRefusal("CURSOR_GAP");
        return eventProjectionRefusal(release ? "SOURCE_INCOMPLETE" : "STORAGE_BUSY");
    }
    finally {
        if (release) {
            await release();
            await options.onTransition?.("released");
        }
    }
}
/** Page exact stored work; subsequent reads recover the same committed revision without refreshing the source. */
function pageReceipt(receipt, limit, offset) {
    const work = receipt.work.slice(offset, offset + limit);
    return { ...receipt, work, nextOffset: offset + work.length < receipt.work.length ? offset + work.length : null };
}
/** Recover bounded work pages from an atomic checkpoint without invoking source SDK readers. */
export async function readEventProjectionReceipt(file, limit = 100, offset = 0) {
    if (!validOptions({ pmRoot: "unused", stateFile: file, limit, offset }))
        return eventProjectionRefusal("INVALID_INPUT");
    try {
        const state = await readEventProjection(file);
        return state ? pageReceipt(state.receipt, limit, offset) : eventProjectionRefusal("FOREIGN_STATE");
    }
    catch {
        return eventProjectionRefusal("FOREIGN_STATE");
    }
}
//# sourceMappingURL=event-projection.js.map