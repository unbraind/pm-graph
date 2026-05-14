import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import neo4j from "neo4j-driver";
const execFileAsync = promisify(execFile);
const EXTENSION_VERSION = "0.1.4";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getWorkspace(context) {
    return context.workspaceRoot ?? context.cwd ?? process.cwd();
}
function projectKeyForWorkspace(workspace) {
    if (process.env.PM_GRAPH_PROJECT_KEY)
        return process.env.PM_GRAPH_PROJECT_KEY;
    // Derive from the workspace directory name for a concise, stable key
    return path.basename(workspace);
}
function neo4jConfigured() {
    return Boolean(process.env.NEO4J_URI &&
        (process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME) &&
        process.env.NEO4J_PASSWORD);
}
function neo4jMissingMessage() {
    const missing = [];
    if (!process.env.NEO4J_URI)
        missing.push("NEO4J_URI");
    if (!process.env.NEO4J_USER && !process.env.NEO4J_USERNAME)
        missing.push("NEO4J_USER");
    if (!process.env.NEO4J_PASSWORD)
        missing.push("NEO4J_PASSWORD");
    return `Neo4j is not configured. Set ${missing.join(", ")} before using this command.`;
}
/**
 * Produce a user-friendly error message for Neo4j connection failures.
 * The neo4j-driver throws errors with codes like ServiceUnavailable or
 * AuthorizationExpired that are not helpful on their own.
 */
function neo4jFriendlyError(err) {
    if (!(err instanceof Error))
        return new Error(String(err));
    const msg = err.message ?? "";
    const code = err.code ?? "";
    if (code === "ServiceUnavailable" ||
        msg.includes("Could not perform discovery") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("connect ETIMEDOUT") ||
        msg.includes("Failed to connect")) {
        const uri = process.env.NEO4J_URI ?? "bolt://localhost:7687";
        return new Error(`Neo4j is not reachable at ${uri}. Check that Neo4j is running and NEO4J_URI is correct.`);
    }
    if (code === "Neo.ClientError.Security.Unauthorized" ||
        msg.includes("authentication failure") ||
        msg.includes("Unauthorized")) {
        return new Error("Neo4j authentication failed. Check NEO4J_USER and NEO4J_PASSWORD.");
    }
    return err;
}
function createDriver() {
    const uri = process.env.NEO4J_URI;
    const user = process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME;
    const password = process.env.NEO4J_PASSWORD;
    if (!uri || !user || !password) {
        throw new Error(neo4jMissingMessage());
    }
    return neo4j.driver(uri, neo4j.auth.basic(user, password), {
        // Close idle connections after 5 minutes
        maxConnectionLifetime: 5 * 60 * 1000,
        // Give up acquiring a connection within 10 seconds
        connectionAcquisitionTimeout: 10_000,
        // Allow at most 10 concurrent connections per pool
        maxConnectionPoolSize: 10,
    });
}
function neo4jSession(driver) {
    return driver.session({ database: process.env.NEO4J_DATABASE });
}
/**
 * Convert a Neo4j driver value (Integer, Node, Relationship, Path, …)
 * into a plain JSON-safe value.
 */
function toPlain(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value !== "object")
        return value;
    // Neo4j Integer
    if (neo4j.isInt(value))
        return value.toNumber();
    // Neo4j Node
    if (neo4j.isNode(value)) {
        return {
            _labels: value.labels,
            _elementId: value.elementId,
            ...value.properties,
        };
    }
    // Neo4j Relationship
    if (neo4j.isRelationship(value)) {
        return {
            _type: value.type,
            _elementId: value.elementId,
            _startNodeElementId: value.startNodeElementId,
            _endNodeElementId: value.endNodeElementId,
            ...value.properties,
        };
    }
    // Neo4j Path
    if (neo4j.isPath(value)) {
        return {
            start: toPlain(value.start),
            end: toPlain(value.end),
            segments: value.segments.map((s) => ({
                start: toPlain(s.start),
                relationship: toPlain(s.relationship),
                end: toPlain(s.end),
            })),
            length: value.length,
        };
    }
    if (Array.isArray(value))
        return value.map(toPlain);
    if (typeof value === "object") {
        const obj = {};
        for (const [k, v] of Object.entries(value)) {
            obj[k] = toPlain(v);
        }
        return obj;
    }
    return value;
}
// ---------------------------------------------------------------------------
// PM CLI interaction
// ---------------------------------------------------------------------------
async function runPmJson(context, args) {
    const cliEntry = process.argv[1];
    const command = cliEntry ? process.execPath : "pm";
    const commandArgs = cliEntry ? [cliEntry, ...args, "--json"] : [...args, "--json"];
    try {
        const { stdout } = await execFileAsync(command, commandArgs, {
            cwd: getWorkspace(context),
            timeout: 30_000,
            maxBuffer: 20 * 1024 * 1024,
        });
        return JSON.parse(stdout);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to run pm ${args.join(" ")}: ${msg}`);
    }
}
// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------
function relationshipType(rawType) {
    const text = typeof rawType === "string" && rawType.length > 0 ? rawType : "relates_to";
    return text.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}
function relationshipTarget(dep) {
    for (const key of ["id", "target", "target_id", "targetId", "item", "item_id", "itemId"]) {
        const value = dep[key];
        if (typeof value === "string" && value.length > 0)
            return value;
    }
    return null;
}
function dependencyRows(raw) {
    if (Array.isArray(raw)) {
        return raw.filter((entry) => Boolean(entry) && typeof entry === "object");
    }
    if (!raw || typeof raw !== "object")
        return [];
    const data = raw;
    for (const key of ["deps", "dependencies", "items", "relationships"]) {
        const value = data[key];
        if (Array.isArray(value)) {
            return value.filter((entry) => Boolean(entry) && typeof entry === "object");
        }
    }
    return [];
}
function facetNodeId(kind, value) {
    return `${kind}:${value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
}
function graphFromItems(items, workspace, depsByItem) {
    const nodesById = new Map();
    const relationships = [];
    const addNode = (node) => {
        if (!nodesById.has(node.id))
            nodesById.set(node.id, node);
    };
    const addRelationship = (from, to, type, properties) => {
        if (!nodesById.has(to) && !items.some((item) => item.id === to)) {
            addNode({
                id: to,
                labels: ["ExternalPmItem"],
                properties: { id: to, title: to, type: "ExternalPmItem" },
            });
        }
        relationships.push({ from, to, type, properties });
    };
    for (const item of items) {
        addNode({
            id: item.id,
            labels: ["PmItem", item.type ?? "Item"].filter(Boolean),
            properties: {
                id: item.id,
                title: item.title ?? "",
                type: item.type ?? "Item",
                status: item.status ?? "unknown",
                priority: item.priority ?? null,
                tags: item.tags ?? [],
                assignee: item.assignee ?? null,
                sprint: item.sprint ?? null,
                release: item.release ?? null,
                deadline: item.deadline ?? null,
                created_at: item.created_at ?? null,
                updated_at: item.updated_at ?? null,
            },
        });
        if (item.parent) {
            addRelationship(item.id, item.parent, "CHILD_OF", { source: "parent" });
        }
        const blockedBy = item.blocked_by ?? item.blockedBy;
        if (typeof blockedBy === "string" && blockedBy.trim().length > 0) {
            addRelationship(item.id, blockedBy.trim(), "BLOCKED_BY", {
                source: "blocked_by",
                reason: item.blocked_reason ?? item.blockedReason ?? null,
            });
        }
        const deps = [
            ...(item.deps ?? []),
            ...(item.dependencies ?? []),
            ...(depsByItem.get(item.id) ?? []),
        ];
        const seenDeps = new Set();
        for (const dep of deps) {
            const target = relationshipTarget(dep);
            if (!target)
                continue;
            const type = relationshipType(dep.type ?? dep.kind ?? dep.relation ?? dep.rel ?? dep.relationship);
            const key = `${item.id}->${target}:${type}`;
            if (seenDeps.has(key))
                continue;
            seenDeps.add(key);
            addRelationship(item.id, target, type, { ...dep });
        }
        const facets = [
            { kind: "type", value: item.type, label: "ItemType", rel: "HAS_TYPE" },
            { kind: "status", value: item.status, label: "Status", rel: "HAS_STATUS" },
            { kind: "assignee", value: item.assignee, label: "Person", rel: "ASSIGNED_TO" },
            { kind: "sprint", value: item.sprint, label: "Sprint", rel: "IN_SPRINT" },
            { kind: "release", value: item.release, label: "Release", rel: "IN_RELEASE" },
        ];
        for (const facet of facets) {
            if (typeof facet.value !== "string" || facet.value.trim().length === 0)
                continue;
            const id = facetNodeId(facet.kind, facet.value);
            addNode({
                id,
                labels: ["PmFacet", facet.label],
                properties: { id, title: facet.value, kind: facet.kind, value: facet.value },
            });
            addRelationship(item.id, id, facet.rel, { source: facet.kind });
        }
        for (const tag of item.tags ?? []) {
            if (!tag.trim())
                continue;
            const id = facetNodeId("tag", tag);
            addNode({
                id,
                labels: ["PmFacet", "Tag"],
                properties: { id, title: tag, kind: "tag", value: tag },
            });
            addRelationship(item.id, id, "TAGGED_WITH", { source: "tags" });
        }
    }
    return {
        generatedAt: new Date().toISOString(),
        workspace,
        projectKey: projectKeyForWorkspace(workspace),
        nodes: Array.from(nodesById.values()),
        relationships: relationships.filter((relationship, index, all) => all.findIndex((candidate) => candidate.from === relationship.from &&
            candidate.to === relationship.to &&
            candidate.type === relationship.type) === index),
    };
}
async function loadGraph(context) {
    const result = await runPmJson(context, ["list-all"]);
    const items = result.items ?? [];
    const depsByItem = new Map();
    await Promise.all(items.map(async (item) => {
        try {
            const deps = await runPmJson(context, ["deps", item.id]);
            depsByItem.set(item.id, dependencyRows(deps));
        }
        catch {
            depsByItem.set(item.id, []);
        }
    }));
    return graphFromItems(items, getWorkspace(context), depsByItem);
}
// ---------------------------------------------------------------------------
// Cypher generation (for export)
// ---------------------------------------------------------------------------
function cypherStatements(graph) {
    const statements = [
        {
            statement: "MATCH (n:PmGraphNode {projectKey: $projectKey}) DETACH DELETE n",
            parameters: { projectKey: graph.projectKey },
        },
    ];
    statements.push(...graph.nodes.map((node) => ({
        statement: "MERGE (n:PmGraphNode {projectKey: $projectKey, id: $id}) SET n += $properties, n.labels = $labels RETURN n.id",
        parameters: {
            projectKey: graph.projectKey,
            id: node.id,
            labels: node.labels,
            properties: { ...node.properties, projectKey: graph.projectKey },
        },
    })));
    for (const relationship of graph.relationships) {
        statements.push({
            statement: `MATCH (from:PmGraphNode {projectKey: $projectKey, id: $from}), (to:PmGraphNode {projectKey: $projectKey, id: $to}) MERGE (from)-[r:${relationship.type}]->(to) SET r += $properties RETURN type(r)`,
            parameters: {
                projectKey: graph.projectKey,
                from: relationship.from,
                to: relationship.to,
                properties: relationship.properties,
            },
        });
    }
    return statements;
}
async function syncNeo4j(graph, options) {
    const driver = createDriver();
    const session = neo4jSession(driver);
    const projectKey = graph.projectKey;
    const currentIds = new Set(graph.nodes.map((n) => n.id));
    try {
        if (options.fullSync) {
            // Full resync: wipe all graph nodes for this project first
            await session.executeWrite((tx) => tx.run("MATCH (n:PmGraphNode {projectKey: $projectKey}) DETACH DELETE n", { projectKey }));
        }
        // Upsert nodes with progress-friendly batching
        for (let i = 0; i < graph.nodes.length; i++) {
            const node = graph.nodes[i];
            await session.executeWrite((tx) => tx.run("MERGE (n:PmGraphNode {projectKey: $projectKey, id: $id}) SET n += $properties, n.labels = $labels RETURN n.id", {
                projectKey,
                id: node.id,
                labels: node.labels,
                properties: { ...node.properties, projectKey },
            }));
        }
        // Upsert relationships
        for (const relationship of graph.relationships) {
            await session.executeWrite((tx) => tx.run(`MATCH (from:PmGraphNode {projectKey: $projectKey, id: $from}), (to:PmGraphNode {projectKey: $projectKey, id: $to}) MERGE (from)-[r:${relationship.type}]->(to) SET r += $properties RETURN type(r)`, {
                projectKey,
                from: relationship.from,
                to: relationship.to,
                properties: relationship.properties,
            }));
        }
        // Incremental mode: delete stale nodes that were not in this sync
        let deletedStaleNodes = 0;
        if (!options.fullSync && currentIds.size > 0) {
            const deleteResult = await session.executeWrite((tx) => tx.run("MATCH (n:PmGraphNode {projectKey: $projectKey}) WHERE NOT n.id IN $currentIds DETACH DELETE n RETURN count(n) AS deleted", { projectKey, currentIds: [...currentIds] }));
            deletedStaleNodes = deleteResult.records[0]?.get("deleted")?.toNumber() ?? 0;
        }
        // Store last sync timestamp
        await session.executeWrite((tx) => tx.run("MERGE (m:PmGraphSync {projectKey: $projectKey}) SET m.lastSyncedAt = $timestamp, m.syncVersion = $version", { projectKey, timestamp: new Date().toISOString(), version: EXTENSION_VERSION }));
        return {
            syncedNodes: graph.nodes.length,
            syncedRelationships: graph.relationships.length,
            deletedStaleNodes,
        };
    }
    catch (err) {
        throw neo4jFriendlyError(err);
    }
    finally {
        await session.close();
        await driver.close();
    }
}
// ---------------------------------------------------------------------------
// Cypher query sanitisation
// ---------------------------------------------------------------------------
const DESTRUCTIVE_KEYWORDS = [
    /\bCREATE\b/,
    /\bMERGE\b/,
    /\bDELETE\b/,
    /\bDETACH\b/,
    /\bDROP\b/,
    /\bREMOVE\b/,
    /\bSET\b(?!\s*\bSESSION\b)/,
];
const DESTRUCTIVE_NAMES = [
    "CREATE",
    "MERGE",
    "DELETE",
    "DETACH",
    "DROP",
    "REMOVE",
    "SET",
];
function findDestructiveKeyword(query) {
    const upper = query.toUpperCase();
    for (let i = 0; i < DESTRUCTIVE_KEYWORDS.length; i++) {
        if (DESTRUCTIVE_KEYWORDS[i].test(upper))
            return DESTRUCTIVE_NAMES[i];
    }
    return null;
}
// ---------------------------------------------------------------------------
// Help text helpers
// ---------------------------------------------------------------------------
function hasHelpFlag(context) {
    const args = context.args ?? [];
    return args.includes("--help") || args.includes("-h");
}
// ---------------------------------------------------------------------------
// Command registrations
// ---------------------------------------------------------------------------
export function activate(api) {
    // --- pm-graph ping -------------------------------------------------------
    api.registerCommand({
        name: "pm-graph ping",
        description: "Verify that the pm-graph extension is active.",
        run: async (context) => {
            if (hasHelpFlag(context)) {
                return {
                    usage: "pm pm-graph ping [--json]",
                    description: "Verify that the pm-graph extension is active. Returns extension version and whether Neo4j is configured.",
                    flags: {
                        "--json": "Output as JSON",
                    },
                };
            }
            return {
                ok: true,
                source: "pm-graph",
                command: context.command,
                neo4jConfigured: neo4jConfigured(),
                version: EXTENSION_VERSION,
            };
        },
    });
    // --- pm-graph export -----------------------------------------------------
    api.registerCommand({
        name: "pm-graph export",
        description: "Export the current workspace as dependency and knowledge graph JSON.",
        run: async (context) => {
            if (hasHelpFlag(context)) {
                return {
                    usage: "pm pm-graph export [--json]",
                    description: "Export the current workspace as a dependency and knowledge graph. Does not require Neo4j.",
                    flags: {
                        "--json": "Output as JSON",
                    },
                    output: {
                        graph: "Object containing nodes[], relationships[], projectKey, workspace, generatedAt",
                    },
                };
            }
            try {
                return {
                    ok: true,
                    graph: await loadGraph(context),
                };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                throw new Error(`Export failed: ${msg}`);
            }
        },
    });
    // --- pm-graph cypher -----------------------------------------------------
    api.registerCommand({
        name: "pm-graph cypher",
        description: "Render Cypher statements for importing the current workspace graph into Neo4j.",
        run: async (context) => {
            if (hasHelpFlag(context)) {
                return {
                    usage: "pm pm-graph cypher [--json]",
                    description: "Render parameterized Cypher statements for importing the current workspace graph into Neo4j. Does not execute them.",
                    flags: {
                        "--json": "Output as JSON",
                    },
                    output: {
                        statements: "Array of { statement, parameters } objects ready to execute against Neo4j",
                    },
                };
            }
            try {
                const graph = await loadGraph(context);
                return {
                    ok: true,
                    graph: {
                        nodes: graph.nodes.length,
                        relationships: graph.relationships.length,
                    },
                    statements: cypherStatements(graph),
                };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                throw new Error(`Cypher generation failed: ${msg}`);
            }
        },
    });
    // --- pm-graph sync -------------------------------------------------------
    api.registerCommand({
        name: "pm-graph sync",
        description: "Sync the current workspace graph into Neo4j. Add --full for a complete wipe-and-resync.",
        run: async (context) => {
            const args = context.args ?? [];
            if (hasHelpFlag(context)) {
                return {
                    usage: "pm pm-graph sync [--full] [--json]",
                    description: "Sync the current workspace graph into Neo4j. Requires NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD.",
                    flags: {
                        "--full": "Full wipe-and-resync: deletes all existing PmGraphNode entries for this project before re-importing",
                        "--json": "Output as JSON",
                    },
                    output: {
                        syncedNodes: "Number of nodes upserted",
                        syncedRelationships: "Number of relationships upserted",
                        deletedStaleNodes: "Number of stale nodes removed (incremental mode only)",
                        fullSync: "Whether --full was used",
                    },
                };
            }
            const fullSync = args.includes("--full");
            if (!neo4jConfigured()) {
                throw new Error(neo4jMissingMessage());
            }
            let graph;
            try {
                graph = await loadGraph(context);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                throw new Error(`Failed to load workspace graph: ${msg}`);
            }
            const result = await syncNeo4j(graph, { fullSync });
            return {
                ok: true,
                projectKey: graph.projectKey,
                syncedNodes: result.syncedNodes,
                syncedRelationships: result.syncedRelationships,
                deletedStaleNodes: result.deletedStaleNodes,
                fullSync,
            };
        },
    });
    // --- pm-graph status -----------------------------------------------------
    api.registerCommand({
        name: "pm-graph status",
        description: "Show Neo4j configuration status, node/relationship counts, last sync timestamp, and extension version.",
        run: async (context) => {
            if (hasHelpFlag(context)) {
                return {
                    usage: "pm pm-graph status [--json]",
                    description: "Show Neo4j configuration status, node/relationship counts for the current project, local pm item count, and extension version.",
                    flags: {
                        "--json": "Output as JSON",
                    },
                    output: {
                        neo4jConfigured: "Whether NEO4J_URI/NEO4J_USER/NEO4J_PASSWORD are all set",
                        projectKey: "Derived project key (from PM_GRAPH_PROJECT_KEY or directory name)",
                        workspace: "Current workspace path",
                        localItemCount: "Number of pm items found locally",
                        nodeCount: "Number of PmGraphNode entries in Neo4j (if connected)",
                        relationshipCount: "Number of relationships between PmGraphNode entries (if connected)",
                        lastSyncedAt: "Timestamp of the most recent sync (or null)",
                        version: "Extension version",
                    },
                };
            }
            const workspace = getWorkspace(context);
            const projectKey = projectKeyForWorkspace(workspace);
            const configured = neo4jConfigured();
            // Always fetch local item count regardless of Neo4j availability
            let localItemCount = 0;
            try {
                const result = await runPmJson(context, ["list-all"]);
                localItemCount = result.items?.length ?? 0;
            }
            catch {
                // Non-fatal: workspace may not be initialised
            }
            if (!configured) {
                return {
                    ok: true,
                    neo4jConfigured: false,
                    message: neo4jMissingMessage(),
                    projectKey,
                    workspace,
                    localItemCount,
                    version: EXTENSION_VERSION,
                };
            }
            const driver = createDriver();
            const session = neo4jSession(driver);
            try {
                const nodeResult = await session.executeRead((tx) => tx.run("MATCH (n:PmGraphNode {projectKey: $projectKey}) RETURN count(n) AS count", { projectKey }));
                const nodeCount = nodeResult.records[0]?.get("count")?.toNumber() ?? 0;
                const relResult = await session.executeRead((tx) => tx.run("MATCH (:PmGraphNode {projectKey: $projectKey})-[r]->(:PmGraphNode {projectKey: $projectKey}) RETURN count(r) AS count", { projectKey }));
                const relCount = relResult.records[0]?.get("count")?.toNumber() ?? 0;
                const syncResult = await session.executeRead((tx) => tx.run("MATCH (m:PmGraphSync {projectKey: $projectKey}) RETURN m.lastSyncedAt AS lastSyncedAt, m.syncVersion AS syncVersion", { projectKey }));
                const lastSyncedAt = syncResult.records[0]?.get("lastSyncedAt") ?? null;
                const syncVersion = syncResult.records[0]?.get("syncVersion") ?? null;
                return {
                    ok: true,
                    neo4jConfigured: true,
                    projectKey,
                    workspace,
                    localItemCount,
                    nodeCount,
                    relationshipCount: relCount,
                    lastSyncedAt,
                    syncVersion,
                    version: EXTENSION_VERSION,
                };
            }
            catch (err) {
                throw neo4jFriendlyError(err);
            }
            finally {
                await session.close();
                await driver.close();
            }
        },
    });
    // --- pm-graph query ------------------------------------------------------
    api.registerCommand({
        name: "pm-graph query",
        description: "Run a read-only Cypher query against Neo4j and return JSON results. Destructive keywords are blocked.",
        run: async (context) => {
            if (hasHelpFlag(context)) {
                return {
                    usage: 'pm pm-graph query "<cypher-query>" [--json]',
                    description: "Run a read-only Cypher query against Neo4j. Destructive keywords (CREATE, MERGE, DELETE, DETACH, DROP, REMOVE, SET) are blocked.",
                    flags: {
                        "--json": "Output as JSON",
                    },
                    example: "pm pm-graph query \"MATCH (n:PmGraphNode {projectKey: 'my-project'}) RETURN n.id, n.title LIMIT 10\" --json",
                    output: {
                        count: "Number of records returned",
                        records: "Array of result objects with all Neo4j types converted to plain JSON",
                    },
                };
            }
            const query = (context.args ?? []).join(" ").trim();
            if (!query) {
                throw new Error('Usage: pm pm-graph query "<cypher-query>"\nExample: pm pm-graph query "MATCH (n:PmGraphNode) RETURN n.id LIMIT 5"');
            }
            const destructive = findDestructiveKeyword(query);
            if (destructive) {
                throw new Error(`Blocked destructive Cypher keyword "${destructive}". Only read-only queries (MATCH / RETURN / WITH / ORDER BY / LIMIT / SKIP / WHERE) are allowed.`);
            }
            if (!neo4jConfigured()) {
                throw new Error(neo4jMissingMessage());
            }
            const driver = createDriver();
            const session = neo4jSession(driver);
            try {
                const result = await session.executeRead((tx) => tx.run(query));
                const records = result.records.map((record) => {
                    const obj = {};
                    for (const key of record.keys) {
                        obj[key] = toPlain(record.get(key));
                    }
                    return obj;
                });
                return { ok: true, count: records.length, records };
            }
            catch (err) {
                throw neo4jFriendlyError(err);
            }
            finally {
                await session.close();
                await driver.close();
            }
        },
    });
    // --- pm-graph neighbors --------------------------------------------------
    api.registerCommand({
        name: "pm-graph neighbors",
        description: "Return all 1-hop neighbors with relationships for a given node ID.",
        run: async (context) => {
            if (hasHelpFlag(context)) {
                return {
                    usage: "pm pm-graph neighbors <node-id> [--json]",
                    description: "Return all 1-hop neighbors and their relationships for a given node ID in Neo4j.",
                    flags: {
                        "--json": "Output as JSON",
                    },
                    example: "pm pm-graph neighbors TASK-42 --json",
                    output: {
                        center: "The queried node (or null if not found)",
                        neighbors: "Array of { node, relationship: { type, direction, properties } }",
                    },
                };
            }
            const nodeId = (context.args ?? [])[0];
            if (!nodeId) {
                throw new Error("Usage: pm pm-graph neighbors <node-id>\nExample: pm pm-graph neighbors TASK-42");
            }
            if (!neo4jConfigured()) {
                throw new Error(neo4jMissingMessage());
            }
            const projectKey = projectKeyForWorkspace(getWorkspace(context));
            const driver = createDriver();
            const session = neo4jSession(driver);
            try {
                const result = await session.executeRead((tx) => tx.run(`MATCH (center:PmGraphNode {projectKey: $projectKey, id: $nodeId})-[r]-(neighbor:PmGraphNode {projectKey: $projectKey})
             RETURN center, r, neighbor, type(r) AS relType,
                    CASE WHEN startNode(r) = center THEN 'outgoing' ELSE 'incoming' END AS direction`, { projectKey, nodeId }));
                if (result.records.length === 0) {
                    return {
                        ok: true,
                        center: null,
                        neighbors: [],
                        message: `No node found with id "${nodeId}" for project "${projectKey}".`,
                    };
                }
                const center = toPlain(result.records[0].get("center"));
                const neighbors = result.records.map((record) => ({
                    node: toPlain(record.get("neighbor")),
                    relationship: {
                        type: record.get("relType"),
                        direction: record.get("direction"),
                        properties: toPlain(record.get("r")),
                    },
                }));
                return { ok: true, center, neighbors };
            }
            catch (err) {
                throw neo4jFriendlyError(err);
            }
            finally {
                await session.close();
                await driver.close();
            }
        },
    });
}
export default { activate };
//# sourceMappingURL=index.js.map