import { RelationshipGraph, RelationshipKindRegistry } from "@unbrained/pm-cli/sdk/graph";
import { dense, identity, record } from "./strict-input.js";
/** One refusal contract for the SDK, CLI file reader and source acquisition. */
export function evidencePathRefusal(code, remedy) {
    return { ok: false, exit_code: 2, rows: [], refusal: { code, remedy } };
}
/** Adapt package projections without exposing metadata or inferring a cost from content. */
export function evidencePathInputFromGraph(graph, options) {
    return { ...options, nodes: graph.nodes.map((node) => ({ id: node.id, unknown: !node.labels.includes("PmItem") })),
        edges: graph.relationships.map(({ from, to, type }) => ({ from, to, type })) };
}
/** Finite integer domains prevent precision loss even at the maximum simple-path length. */
function integer(value, min, max) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
/** The sole input schema is shared by direct calls and the CLI's assembled input. */
function valid(value) {
    if (!record(value, ["nodes", "edges", "from", "to", "edgeTypes", "costs", "maxSettled", "maxWork", "maxPathNodes"]))
        return false;
    if (!dense(value.nodes, 10000, (node) => record(node, ["id", "unknown"]) && identity(node.id) && (node.unknown === undefined || typeof node.unknown === "boolean"))
        || !dense(value.edges, 50000, (edge) => record(edge, ["from", "to", "type"]) && identity(edge.from) && identity(edge.to) && identity(edge.type))
        || !dense(value.costs, 10000, (row) => record(row, ["id", "cost"]) && identity(row.id) && (row.cost === null || integer(row.cost, 0, 1e9)))
        || !dense(value.edgeTypes, 64, identity) || value.edgeTypes.length === 0 || !identity(value.from) || !identity(value.to))
        return false;
    const nodes = value.nodes;
    const costs = value.costs;
    const ids = new Set(nodes.map((node) => node.id));
    return ids.size === nodes.length && new Set(costs.map((row) => row.id)).size === costs.length
        && costs.every((row) => ids.has(row.id)) && new Set(value.edgeTypes).size === value.edgeTypes.length
        && (value.maxSettled === undefined || integer(value.maxSettled, 1, 10000))
        && (value.maxWork === undefined || integer(value.maxWork, 1, 1000000))
        && (value.maxPathNodes === undefined || integer(value.maxPathNodes, 1, 1000));
}
/** Deterministic min-heap order leaves equal-cost alternatives stable across input order. */
function before(a, b) {
    return a.distance < b.distance || (a.distance === b.distance && a.id < b.id);
}
/** Insert without sorting the complete frontier on every relaxation. */
function push(heap, row) {
    heap.push(row);
    let i = heap.length - 1;
    while (i > 0) {
        const parent = (i - 1) >>> 1;
        if (!before(row, heap[parent]))
            break;
        heap[i] = heap[parent];
        i = parent;
    }
    heap[i] = row;
}
/** Remove the minimum in logarithmic work; stale entries are checked by the search. */
function pop(heap) {
    const first = heap[0];
    const last = heap.pop();
    if (heap.length) {
        let i = 0;
        while (2 * i + 1 < heap.length) {
            let child = 2 * i + 1;
            if (child + 1 < heap.length && before(heap[child + 1], heap[child]))
                child++;
            if (!before(heap[child], last))
                break;
            heap[i] = heap[child];
            i = child;
        }
        heap[i] = last;
    }
    return first;
}
/** Reconstruct only reached nodes from a strict-improvement predecessor tree. */
function pathTo(target, distances, parents) {
    if (!distances.has(target))
        return [];
    const path = [target];
    while (parents.has(path[0]))
        path.unshift(parents.get(path[0]));
    return path;
}
/**
 * Dijkstra on SDK adjacency. Unknown costs are either excluded or set to zero
 * ONLY for a lower-bound proof. Mid-expansion stops retain the current distance
 * as a conservative bound, including edges not yet visited. No frozen state is saved.
 */
function search(graph, input, costs, optimistic) {
    const receipt = { settled: 0, work: 0, stop: "exhausted", lowerBound: null };
    const source = JSON.stringify(input.from);
    const target = JSON.stringify(input.to);
    const sourceCost = costs.get(source) ?? null;
    if (sourceCost === null && !optimistic)
        return { path: [], receipt };
    const distances = new Map([[source, sourceCost ?? 0]]);
    const parents = new Map();
    const settled = new Set();
    const heap = [{ id: source, distance: sourceCost ?? 0 }];
    const maxWork = input.maxWork ?? 100000;
    const maxSettled = input.maxSettled ?? 10000;
    while (heap.length) {
        receipt.lowerBound = heap[0].distance;
        if (receipt.work >= maxWork) {
            receipt.stop = "maxWork";
            break;
        }
        if (receipt.settled >= maxSettled) {
            receipt.stop = "maxSettled";
            break;
        }
        const current = pop(heap);
        receipt.work++;
        if (settled.has(current.id) || distances.get(current.id) !== current.distance)
            continue;
        settled.add(current.id);
        receipt.settled++;
        if (current.id === target) {
            receipt.stop = "goal";
            break;
        }
        const neighbors = graph.adjacency(current.id).value;
        let stopped = false;
        for (const id of neighbors) {
            if (receipt.work >= maxWork) {
                stopped = true;
                break;
            }
            receipt.work++;
            const cost = costs.get(id) ?? null;
            if ((cost === null && !optimistic) || settled.has(id))
                continue;
            const distance = current.distance + (cost ?? 0);
            if (!distances.has(id) || distance < distances.get(id)) {
                distances.set(id, distance);
                parents.set(id, current.id);
                push(heap, { id, distance });
            }
        }
        if (stopped) {
            receipt.stop = "maxWork";
            receipt.lowerBound = current.distance;
            break;
        }
    }
    if (!heap.length && receipt.stop === "exhausted")
        receipt.lowerBound = null;
    return { path: pathTo(target, distances, parents), receipt };
}
/** Check every emitted number independently of JSON serialization (which hides Infinity). */
function finiteOutput(value, limits, field = "") {
    if (typeof value === "number")
        return integer(value, 0, limits.get(field));
    if (value !== null && typeof value === "object") {
        for (const [key, entry] of Object.entries(value))
            if (!finiteOutput(entry, limits, key))
                return false;
    }
    return true;
}
/** Rank valid directed witnesses by additive declared item-read cost, with truthful bounded proofs. */
export function explainEvidencePath(input) {
    if (!valid(input))
        return evidencePathRefusal("INVALID_INPUT", "Supply strict dense nodes <=10000, edges <=50000, edgeTypes 1-64, unique costs for existing ids (null or integer 0-1000000000), exact ids <=256 characters; maxSettled 1-10000, maxWork 1-1000000, maxPathNodes 1-1000. Remove unknown fields.");
    const nodes = new Map(input.nodes.map((node) => [node.id, node]));
    if (!nodes.has(input.from) || !nodes.has(input.to) || nodes.get(input.from).unknown || nodes.get(input.to).unknown)
        return evidencePathRefusal("UNKNOWN_ENDPOINT", "Choose two exact available item ids from the current complete projection.");
    const selected = new Set(input.edgeTypes);
    const edges = input.edges.filter((edge) => selected.has(edge.type));
    if (edges.some((edge) => !nodes.has(edge.from) || !nodes.has(edge.to) || nodes.get(edge.from).unknown || nodes.get(edge.to).unknown))
        return evidencePathRefusal("SOURCE_INCOMPLETE", "Restore every endpoint of the selected edge types or supply a complete authorized projection with explicit scope; unavailable topology cannot prove a witness.");
    const registry = new RelationshipKindRegistry([{ kind: "read_arrow", direction: "directed", ordering: false, hierarchy: false,
            outgoing: "many", incoming: "many", lifecycle: "ephemeral", compatibilityVersion: 1, allowSelf: true }]);
    const graph = new RelationshipGraph(input.nodes.map((node) => JSON.stringify(node.id)), edges.map((edge) => ({ source: JSON.stringify(edge.from), target: JSON.stringify(edge.to), kind: "read_arrow" })), registry);
    const costs = new Map(input.costs.map((row) => [JSON.stringify(row.id), row.cost]));
    const types = new Map();
    for (const edge of edges) {
        const pair = JSON.stringify([edge.from, edge.to]);
        if (!types.has(pair) || edge.type < types.get(pair))
            types.set(pair, edge.type);
    }
    const shortest = graph.shortestPath(JSON.stringify(input.from), JSON.stringify(input.to));
    const known = search(graph, input, costs, false);
    const optimistic = search(graph, input, costs, true);
    /** Derive costs from the actual witness, never from an incomplete queue entry. */
    const witness = (path, kind) => {
        const ids = path.map((id) => JSON.parse(id));
        const unknown = path.filter((id) => (costs.get(id) ?? null) === null).map((id) => JSON.parse(id));
        const knownCost = path.reduce((sum, id) => sum + (costs.get(id) ?? 0), 0);
        return { kind, path: ids, edges: ids.slice(1).map((id, i) => types.get(JSON.stringify([ids[i], id]))),
            hops: Math.max(0, path.length - 1), cost: unknown.length ? null : knownCost, knownCost, unknown };
    };
    const comparison = witness(shortest.value, "shortest-hop");
    let chosen = witness(known.path.length ? known.path : shortest.value, "evidence-cost");
    if (comparison.cost !== null && (chosen.cost === null || comparison.cost < chosen.cost))
        chosen = { ...comparison, kind: "evidence-cost" };
    if (Math.max(comparison.path.length, chosen.path.length) > (input.maxPathNodes ?? 128))
        return evidencePathRefusal("OUTPUT_LIMIT", "Increase maxPathNodes (CLI --max-path-nodes) up to 1000 or select closer endpoints; witnesses are never truncated into invalid paths.");
    const limited = [known.receipt, optimistic.receipt].some((receipt) => receipt.stop === "maxWork" || receipt.stop === "maxSettled");
    // Every unknown read has true nonnegative cost, so this bound proves the
    // incumbent even when other cost inputs or parts of the search are unavailable.
    const proved = chosen.cost !== null && optimistic.receipt.lowerBound !== null && chosen.cost <= optimistic.receipt.lowerBound;
    const result = { ok: true, contract: "declared-item-read-cost-v1", reachable: shortest.value.length > 0,
        optimality: !shortest.value.length ? "no-path" : proved ? "proved" : limited ? "search-limited" : "unknown-costs",
        rows: shortest.value.length ? [chosen, comparison] : [], receipt: {
            nodes: input.nodes.length, edges: edges.length, unknownCosts: input.nodes.filter((node) => (costs.get(JSON.stringify(node.id)) ?? null) === null).length,
            shortest: { visitedNodes: shortest.meta.visitedNodes, inspectedEdges: shortest.meta.inspectedEdges }, known: known.receipt, optimistic: optimistic.receipt,
        } };
    const limits = new Map([
        ["nodes", input.nodes.length], ["edges", edges.length], ["unknownCosts", input.nodes.length],
        ["visitedNodes", input.nodes.length], ["inspectedEdges", edges.length],
        ["settled", input.maxSettled ?? 10000], ["work", input.maxWork ?? 100000],
        ["hops", (input.maxPathNodes ?? 128) - 1],
        ["cost", Math.min(input.nodes.length, input.maxPathNodes ?? 128) * 1e9],
        ["knownCost", Math.min(input.nodes.length, input.maxPathNodes ?? 128) * 1e9],
        ["lowerBound", input.nodes.length * 1e9],
    ]);
    return finiteOutput(result, limits) ? result : evidencePathRefusal("CONTRACT_VIOLATION", "Report invalid numeric output with a minimal synthetic input; no tracker state was changed.");
}
//# sourceMappingURL=evidence-path.js.map