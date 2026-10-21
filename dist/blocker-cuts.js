const DEFAULT_LIMITS = { maxStates: 20_000, maxWork: 2_000_000, maxCuts: 32, maxSize: 8 };
const HARD_LIMITS = { maxStates: 1_000_000, maxWork: 20_000_000, maxCuts: 256, maxSize: 64 };
const FORWARD = new Set(["BLOCKED_BY", "DEPENDS_ON", "REQUIRES"]);
/** Find one closed directed cycle iteratively, without enumerating exponentially many paths. */
function cycleWitness(adjacency, root) {
    const color = new Map();
    const stack = [{ id: root, next: 0 }];
    color.set(root, 1);
    while (stack.length) {
        const frame = stack[stack.length - 1];
        const neighbors = adjacency.get(frame.id);
        if (frame.next === neighbors.length) {
            color.set(frame.id, 2);
            stack.pop();
            continue;
        }
        const id = neighbors[frame.next++];
        if (color.get(id) === 1) {
            return [...stack.slice(stack.findIndex((entry) => entry.id === id)).map((entry) => entry.id), id];
        }
        if (!color.has(id)) {
            color.set(id, 1);
            stack.push({ id, next: 0 });
        }
    }
    return [];
}
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
export function minimalBlockerCuts(graph, goal, options = {}) {
    const limits = { ...DEFAULT_LIMITS };
    const receipt = {
        graph: { scope: "supplied-snapshot", edgePolicy: "BLOCKED_BY|DEPENDS_ON|REQUIRES|reverse:BLOCKS",
            nodes: graph.nodes.length, relationships: graph.relationships.length,
            reachableUnresolved: 0, complete: false, unknownNodes: [], unknownNodeCount: 0,
            unknownStatuses: [], unknownStatusCount: 0, cycle: [] },
        search: { complete: false, reason: "refused", states: 0, work: 0, completeThroughSize: 0,
            minimumCardinality: null, limits },
    };
    const refuse = (code, remedy) => ({ ok: false, goal, refusal: { code, remedy }, receipt });
    for (const key of Object.keys(limits)) {
        const value = options[key] ?? limits[key];
        if (!Number.isSafeInteger(value) || value < 1 || value > HARD_LIMITS[key]) {
            return refuse("INVALID_OPTIONS", `Set ${key} to an integer in 1..${HARD_LIMITS[key]}.`);
        }
        limits[key] = value;
    }
    const resolved = new Set(options.resolvedStatuses ?? ["closed", "canceled"]);
    const unresolved = new Set(options.unresolvedStatuses ?? ["open", "in_progress", "blocked"]);
    if ([...resolved].some((status) => unresolved.has(status))) {
        return refuse("INVALID_OPTIONS", "Supply disjoint resolvedStatuses and unresolvedStatuses.");
    }
    if (graph.nodes.length > 100_000 || graph.relationships.length > 500_000) {
        return refuse("GRAPH_LIMIT", "Supply a certified goal-scoped snapshot below 100000 nodes and 500000 relationships, retaining every prerequisite.");
    }
    const nodes = new Map();
    for (const node of graph.nodes) {
        if (nodes.has(node.id))
            return refuse("INVALID_GRAPH", "Supply unique node ids; reload the complete tracker snapshot.");
        nodes.set(node.id, node);
    }
    if (!nodes.get(goal)?.labels.includes("PmItem")) {
        return refuse("UNKNOWN_GOAL", "Select an exact PmItem id from the complete tracker snapshot.");
    }
    const allEdges = new Map();
    for (const rel of graph.relationships) {
        if (!FORWARD.has(rel.type) && rel.type !== "BLOCKS")
            continue;
        const from = rel.type === "BLOCKS" ? rel.to : rel.from;
        const to = rel.type === "BLOCKS" ? rel.from : rel.to;
        if (!allEdges.has(from))
            allEdges.set(from, new Set());
        allEdges.get(from).add(to);
    }
    const adjacency = new Map();
    const pending = [goal];
    const seen = new Set();
    while (pending.length) {
        const id = pending.pop();
        if (seen.has(id))
            continue;
        seen.add(id);
        const node = nodes.get(id);
        if (!node?.labels.includes("PmItem")) {
            receipt.graph.unknownNodeCount++;
            if (receipt.graph.unknownNodes.length < 32)
                receipt.graph.unknownNodes.push(id);
            continue;
        }
        const status = String(node.properties.status);
        if (resolved.has(status))
            continue;
        if (!unresolved.has(status)) {
            receipt.graph.unknownStatusCount++;
            if (receipt.graph.unknownStatuses.length < 32)
                receipt.graph.unknownStatuses.push(id);
        }
        adjacency.set(id, []);
        receipt.graph.reachableUnresolved = adjacency.size;
        if (adjacency.size > 512)
            return refuse("GRAPH_LIMIT", "Reduce the active goal cone below 513 unresolved items, retaining every prerequisite; inspect immediate blockers first.");
        for (const next of allEdges.get(id) ?? []) {
            const target = nodes.get(next);
            if (target?.labels.includes("PmItem") && resolved.has(String(target.properties.status)))
                continue;
            adjacency.get(id).push(next);
        }
        adjacency.get(id).sort();
        for (const next of adjacency.get(id))
            pending.push(next);
    }
    receipt.graph.reachableUnresolved = adjacency.size;
    receipt.graph.unknownNodes.sort();
    receipt.graph.unknownStatuses.sort();
    if (receipt.graph.unknownNodeCount || receipt.graph.unknownStatusCount) {
        return refuse("INCOMPLETE_GRAPH", "Reload all referenced items with statuses; supply registry status sets for custom workflows. Do not filter or truncate the goal cone.");
    }
    const goalResolved = resolved.has(String(nodes.get(goal).properties.status));
    if (!goalResolved)
        receipt.graph.cycle = cycleWitness(adjacency, goal);
    receipt.graph.complete = true;
    if (receipt.graph.cycle.length)
        return refuse("CYCLE", "Break or explicitly resolve the reported dependency cycle, then reload and retry.");
    const immediateBlockers = adjacency.get(goal) ?? [];
    const cuts = [];
    const finish = (reason) => {
        receipt.search.reason = reason;
        receipt.search.complete = reason === "exhausted";
        return { ok: true, goal, semantics: "upstream-frontier", goalResolved, immediateBlockers, cuts, receipt };
    };
    if (!immediateBlockers.length) {
        cuts.push({ blockers: [], immediatelyUnblocked: true });
        receipt.search.minimumCardinality = 0;
        return finish("exhausted");
    }
    const candidates = [...adjacency.keys()].filter((id) => id !== goal).sort();
    const leaves = new Set(candidates.filter((id) => adjacency.get(id).length === 0));
    const spend = () => {
        if (receipt.search.work === limits.maxWork)
            return false;
        receipt.search.work++;
        return true;
    };
    for (let size = 1; size <= Math.min(limits.maxSize, candidates.length); size++) {
        const indices = Array.from({ length: size }, (_, i) => i);
        let more = true;
        while (more) {
            if (receipt.search.states === limits.maxStates)
                return finish("maxStates");
            receipt.search.states++;
            const selected = indices.map((i) => candidates[i]);
            const selectedSet = new Set(selected);
            let redundant = false;
            for (const cut of cuts) {
                let contains = true;
                for (const id of cut.blockers) {
                    if (!spend())
                        return finish("maxWork");
                    if (!selectedSet.has(id)) {
                        contains = false;
                        break;
                    }
                }
                if (contains) {
                    redundant = true;
                    break;
                }
            }
            if (!redundant) {
                const visit = [goal];
                const visited = new Set();
                let separated = true;
                while (visit.length) {
                    if (!spend())
                        return finish("maxWork");
                    const id = visit.pop();
                    if (selectedSet.has(id) || visited.has(id))
                        continue;
                    visited.add(id);
                    if (leaves.has(id)) {
                        separated = false;
                        break;
                    }
                    for (const next of adjacency.get(id)) {
                        if (!spend())
                            return finish("maxWork");
                        visit.push(next);
                    }
                }
                if (separated) {
                    cuts.push({ blockers: selected, immediatelyUnblocked: immediateBlockers.every((id) => selectedSet.has(id)) });
                    receipt.search.minimumCardinality ??= size;
                    if (cuts.length === limits.maxCuts)
                        return finish("maxCuts");
                }
            }
            let position = size - 1;
            while (position >= 0 && indices[position] === candidates.length - size + position)
                position--;
            more = position >= 0;
            if (more) {
                indices[position]++;
                for (let next = position + 1; next < size; next++)
                    indices[next] = indices[next - 1] + 1;
            }
        }
        receipt.search.completeThroughSize = size;
    }
    return finish(limits.maxSize < candidates.length ? "maxSize" : "exhausted");
}
//# sourceMappingURL=blocker-cuts.js.map