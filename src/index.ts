import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import neo4j from "neo4j-driver";

const execFileAsync = promisify(execFile);

const EXTENSION_VERSION = "0.1.3";

type CommandContext = {
  command?: string;
  args?: string[];
  cwd?: string;
  workspaceRoot?: string;
};

type RegisterCommand = {
  name: string;
  description: string;
  run: (context: CommandContext) => Promise<unknown>;
};

type ExtensionApi = {
  registerCommand(command: RegisterCommand): void;
};

type PmItem = {
  id: string;
  title?: string;
  type?: string;
  status?: string;
  priority?: number;
  tags?: string[];
  parent?: string;
  assignee?: string;
  sprint?: string;
  release?: string;
  deadline?: string;
  deps?: Array<Record<string, unknown>>;
  dependencies?: Array<Record<string, unknown>>;
  blocked_by?: string;
  blockedBy?: string;
  blocked_reason?: string;
  blockedReason?: string;
  metadata?: Record<string, unknown>;
  updated_at?: string;
  created_at?: string;
};

type GraphNode = {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
};

type GraphRelationship = {
  from: string;
  to: string;
  type: string;
  properties: Record<string, unknown>;
};

type Graph = {
  generatedAt: string;
  workspace: string;
  projectKey: string;
  nodes: GraphNode[];
  relationships: GraphRelationship[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getWorkspace(context: CommandContext): string {
  return context.workspaceRoot ?? context.cwd ?? process.cwd();
}

function projectKeyForWorkspace(workspace: string): string {
  if (process.env.PM_GRAPH_PROJECT_KEY) return process.env.PM_GRAPH_PROJECT_KEY;
  // Derive from the workspace directory name for a concise, stable key
  return path.basename(workspace);
}

function neo4jConfigured(): boolean {
  return Boolean(
    process.env.NEO4J_URI &&
    (process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME) &&
    process.env.NEO4J_PASSWORD,
  );
}

function neo4jMissingMessage(): string {
  const missing: string[] = [];
  if (!process.env.NEO4J_URI) missing.push("NEO4J_URI");
  if (!process.env.NEO4J_USER && !process.env.NEO4J_USERNAME) missing.push("NEO4J_USER");
  if (!process.env.NEO4J_PASSWORD) missing.push("NEO4J_PASSWORD");
  return `Neo4j is not configured. Set ${missing.join(", ")} before using this command.`;
}

function createDriver(): neo4j.Driver {
  const uri = process.env.NEO4J_URI!;
  const user = process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME!;
  const password = process.env.NEO4J_PASSWORD!;
  if (!uri || !user || !password) {
    throw new Error(neo4jMissingMessage());
  }
  return neo4j.driver(uri, neo4j.auth.basic(user, password));
}

function neo4jSession(driver: neo4j.Driver): neo4j.Session {
  return driver.session({ database: process.env.NEO4J_DATABASE });
}

/**
 * Convert a Neo4j driver value (Integer, Node, Relationship, Path, …)
 * into a plain JSON-safe value.
 */
function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;

  // Neo4j Integer
  if (neo4j.isInt(value)) return value.toNumber();

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

  if (Array.isArray(value)) return value.map(toPlain);

  if (typeof value === "object") {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      obj[k] = toPlain(v);
    }
    return obj;
  }

  return value;
}

// ---------------------------------------------------------------------------
// PM CLI interaction
// ---------------------------------------------------------------------------

async function runPmJson<T>(context: CommandContext, args: string[]): Promise<T> {
  const cliEntry = process.argv[1];
  const command = cliEntry ? process.execPath : "pm";
  const commandArgs = cliEntry ? [cliEntry, ...args, "--json"] : [...args, "--json"];
  try {
    const { stdout } = await execFileAsync(command, commandArgs, {
      cwd: getWorkspace(context),
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(stdout) as T;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to run pm ${args.join(" ")}: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

function relationshipType(rawType: unknown): string {
  const text = typeof rawType === "string" && rawType.length > 0 ? rawType : "relates_to";
  return text.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function relationshipTarget(dep: Record<string, unknown>): string | null {
  for (const key of ["id", "target", "target_id", "targetId", "item", "item_id", "itemId"]) {
    const value = dep[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function dependencyRows(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
  }
  if (!raw || typeof raw !== "object") return [];
  const data = raw as Record<string, unknown>;
  for (const key of ["deps", "dependencies", "items", "relationships"]) {
    const value = data[key];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
    }
  }
  return [];
}

function facetNodeId(kind: string, value: string): string {
  return `${kind}:${value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
}

function graphFromItems(
  items: PmItem[],
  workspace: string,
  depsByItem: Map<string, Array<Record<string, unknown>>>,
): Graph {
  const nodesById = new Map<string, GraphNode>();
  const relationships: GraphRelationship[] = [];

  const addNode = (node: GraphNode) => {
    if (!nodesById.has(node.id)) nodesById.set(node.id, node);
  };

  const addRelationship = (from: string, to: string, type: string, properties: Record<string, unknown>) => {
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
    const seenDeps = new Set<string>();
    for (const dep of deps) {
      const target = relationshipTarget(dep);
      if (!target) continue;
      const type = relationshipType(dep.type ?? dep.kind ?? dep.relation ?? dep.rel ?? dep.relationship);
      const key = `${item.id}->${target}:${type}`;
      if (seenDeps.has(key)) continue;
      seenDeps.add(key);
      addRelationship(item.id, target, type, { ...dep });
    }

    const facets: Array<{ kind: string; value?: unknown; label: string; rel: string }> = [
      { kind: "type", value: item.type, label: "ItemType", rel: "HAS_TYPE" },
      { kind: "status", value: item.status, label: "Status", rel: "HAS_STATUS" },
      { kind: "assignee", value: item.assignee, label: "Person", rel: "ASSIGNED_TO" },
      { kind: "sprint", value: item.sprint, label: "Sprint", rel: "IN_SPRINT" },
      { kind: "release", value: item.release, label: "Release", rel: "IN_RELEASE" },
    ];
    for (const facet of facets) {
      if (typeof facet.value !== "string" || facet.value.trim().length === 0) continue;
      const id = facetNodeId(facet.kind, facet.value);
      addNode({
        id,
        labels: ["PmFacet", facet.label],
        properties: { id, title: facet.value, kind: facet.kind, value: facet.value },
      });
      addRelationship(item.id, id, facet.rel, { source: facet.kind });
    }

    for (const tag of item.tags ?? []) {
      if (!tag.trim()) continue;
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
    relationships: relationships.filter(
      (relationship, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.from === relationship.from &&
            candidate.to === relationship.to &&
            candidate.type === relationship.type,
        ) === index,
    ),
  };
}

async function loadGraph(context: CommandContext): Promise<Graph> {
  const result = await runPmJson<{ items?: PmItem[] }>(context, ["list-all"]);
  const items = result.items ?? [];
  const depsByItem = new Map<string, Array<Record<string, unknown>>>();
  await Promise.all(
    items.map(async (item) => {
      try {
        const deps = await runPmJson<unknown>(context, ["deps", item.id]);
        depsByItem.set(item.id, dependencyRows(deps));
      } catch {
        depsByItem.set(item.id, []);
      }
    }),
  );
  return graphFromItems(items, getWorkspace(context), depsByItem);
}

// ---------------------------------------------------------------------------
// Cypher generation (for export)
// ---------------------------------------------------------------------------

function cypherStatements(
  graph: Graph,
): Array<{ statement: string; parameters: Record<string, unknown> }> {
  const statements: Array<{ statement: string; parameters: Record<string, unknown> }> = [
    {
      statement: "MATCH (n:PmGraphNode {projectKey: $projectKey}) DETACH DELETE n",
      parameters: { projectKey: graph.projectKey },
    },
  ];

  statements.push(
    ...graph.nodes.map((node) => ({
      statement:
        "MERGE (n:PmGraphNode {projectKey: $projectKey, id: $id}) SET n += $properties, n.labels = $labels RETURN n.id",
      parameters: {
        projectKey: graph.projectKey,
        id: node.id,
        labels: node.labels,
        properties: { ...node.properties, projectKey: graph.projectKey },
      },
    })),
  );

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

// ---------------------------------------------------------------------------
// Neo4j sync
// ---------------------------------------------------------------------------

type SyncOptions = {
  fullSync: boolean;
};

async function syncNeo4j(
  graph: Graph,
  options: SyncOptions,
): Promise<{
  syncedNodes: number;
  syncedRelationships: number;
  deletedStaleNodes: number;
}> {
  const driver = createDriver();
  const session = neo4jSession(driver);
  const projectKey = graph.projectKey;
  const currentIds = new Set(graph.nodes.map((n) => n.id));

  try {
    if (options.fullSync) {
      // Full resync: wipe all graph nodes for this project first
      await session.executeWrite((tx) =>
        tx.run(
          "MATCH (n:PmGraphNode {projectKey: $projectKey}) DETACH DELETE n",
          { projectKey },
        ),
      );
    }

    // Upsert nodes with progress-friendly batching
    for (let i = 0; i < graph.nodes.length; i++) {
      const node = graph.nodes[i];
      await session.executeWrite((tx) =>
        tx.run(
          "MERGE (n:PmGraphNode {projectKey: $projectKey, id: $id}) SET n += $properties, n.labels = $labels RETURN n.id",
          {
            projectKey,
            id: node.id,
            labels: node.labels,
            properties: { ...node.properties, projectKey },
          },
        ),
      );
    }

    // Upsert relationships
    for (const relationship of graph.relationships) {
      await session.executeWrite((tx) =>
        tx.run(
          `MATCH (from:PmGraphNode {projectKey: $projectKey, id: $from}), (to:PmGraphNode {projectKey: $projectKey, id: $to}) MERGE (from)-[r:${relationship.type}]->(to) SET r += $properties RETURN type(r)`,
          {
            projectKey,
            from: relationship.from,
            to: relationship.to,
            properties: relationship.properties,
          },
        ),
      );
    }

    // Incremental mode: delete stale nodes that were not in this sync
    let deletedStaleNodes = 0;
    if (!options.fullSync && currentIds.size > 0) {
      const deleteResult = await session.executeWrite((tx) =>
        tx.run(
          "MATCH (n:PmGraphNode {projectKey: $projectKey}) WHERE NOT n.id IN $currentIds DETACH DELETE n RETURN count(n) AS deleted",
          { projectKey, currentIds: [...currentIds] },
        ),
      );
      deletedStaleNodes = deleteResult.records[0]?.get("deleted")?.toNumber() ?? 0;
    }

    // Store last sync timestamp
    await session.executeWrite((tx) =>
      tx.run(
        "MERGE (m:PmGraphSync {projectKey: $projectKey}) SET m.lastSyncedAt = $timestamp, m.syncVersion = $version",
        { projectKey, timestamp: new Date().toISOString(), version: EXTENSION_VERSION },
      ),
    );

    return {
      syncedNodes: graph.nodes.length,
      syncedRelationships: graph.relationships.length,
      deletedStaleNodes,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Neo4j sync failed: ${msg}`);
  } finally {
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
] as const;

const DESTRUCTIVE_NAMES = [
  "CREATE",
  "MERGE",
  "DELETE",
  "DETACH",
  "DROP",
  "REMOVE",
  "SET",
] as const;

function findDestructiveKeyword(query: string): string | null {
  const upper = query.toUpperCase();
  for (let i = 0; i < DESTRUCTIVE_KEYWORDS.length; i++) {
    if (DESTRUCTIVE_KEYWORDS[i].test(upper)) return DESTRUCTIVE_NAMES[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Command registrations
// ---------------------------------------------------------------------------

export function activate(api: ExtensionApi): void {
  // --- pm-graph ping -------------------------------------------------------
  api.registerCommand({
    name: "pm-graph ping",
    description: "Verify that the pm-graph extension is active.",
    run: async (context) => ({
      ok: true,
      source: "pm-graph",
      command: context.command,
      neo4jConfigured: neo4jConfigured(),
      version: EXTENSION_VERSION,
    }),
  });

  // --- pm-graph export -----------------------------------------------------
  api.registerCommand({
    name: "pm-graph export",
    description: "Export the current workspace as dependency and knowledge graph JSON.",
    run: async (context) => ({
      ok: true,
      graph: await loadGraph(context),
    }),
  });

  // --- pm-graph cypher -----------------------------------------------------
  api.registerCommand({
    name: "pm-graph cypher",
    description: "Render Cypher statements for importing the current workspace graph into Neo4j.",
    run: async (context) => {
      const graph = await loadGraph(context);
      return {
        ok: true,
        graph: {
          nodes: graph.nodes.length,
          relationships: graph.relationships.length,
        },
        statements: cypherStatements(graph),
      };
    },
  });

  // --- pm-graph sync -------------------------------------------------------
  api.registerCommand({
    name: "pm-graph sync",
    description:
      "Sync the current workspace graph into Neo4j. Add --full for a complete wipe-and-resync.",
    run: async (context) => {
      const args = context.args ?? [];
      const fullSync = args.includes("--full");

      if (!neo4jConfigured()) {
        throw new Error(neo4jMissingMessage());
      }

      const graph = await loadGraph(context);
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
    description:
      "Show Neo4j configuration status, node/relationship counts, last sync timestamp, and extension version.",
    run: async (context) => {
      const workspace = getWorkspace(context);
      const projectKey = projectKeyForWorkspace(workspace);
      const configured = neo4jConfigured();

      if (!configured) {
        return {
          ok: true,
          neo4jConfigured: false,
          message: neo4jMissingMessage(),
          projectKey,
          workspace,
          version: EXTENSION_VERSION,
        };
      }

      const driver = createDriver();
      const session = neo4jSession(driver);
      try {
        const nodeResult = await session.executeRead((tx) =>
          tx.run(
            "MATCH (n:PmGraphNode {projectKey: $projectKey}) RETURN count(n) AS count",
            { projectKey },
          ),
        );
        const nodeCount = nodeResult.records[0]?.get("count")?.toNumber() ?? 0;

        const relResult = await session.executeRead((tx) =>
          tx.run(
            "MATCH (:PmGraphNode {projectKey: $projectKey})-[r]->(:PmGraphNode {projectKey: $projectKey}) RETURN count(r) AS count",
            { projectKey },
          ),
        );
        const relCount = relResult.records[0]?.get("count")?.toNumber() ?? 0;

        const syncResult = await session.executeRead((tx) =>
          tx.run(
            "MATCH (m:PmGraphSync {projectKey: $projectKey}) RETURN m.lastSyncedAt AS lastSyncedAt, m.syncVersion AS syncVersion",
            { projectKey },
          ),
        );
        const lastSyncedAt = syncResult.records[0]?.get("lastSyncedAt") ?? null;
        const syncVersion = syncResult.records[0]?.get("syncVersion") ?? null;

        return {
          ok: true,
          neo4jConfigured: true,
          projectKey,
          workspace,
          nodeCount,
          relationshipCount: relCount,
          lastSyncedAt,
          syncVersion,
          version: EXTENSION_VERSION,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to query Neo4j status: ${msg}`);
      } finally {
        await session.close();
        await driver.close();
      }
    },
  });

  // --- pm-graph query ------------------------------------------------------
  api.registerCommand({
    name: "pm-graph query",
    description:
      "Run a read-only Cypher query against Neo4j and return JSON results. Destructive keywords are blocked.",
    run: async (context) => {
      const query = (context.args ?? []).join(" ").trim();
      if (!query) {
        throw new Error("Usage: pm pm-graph query <cypher-query>");
      }

      const destructive = findDestructiveKeyword(query);
      if (destructive) {
        throw new Error(
          `Blocked destructive Cypher keyword "${destructive}". Only read-only queries (MATCH / RETURN / WITH / ORDER BY / LIMIT / SKIP / WHERE) are allowed.`,
        );
      }

      if (!neo4jConfigured()) {
        throw new Error(neo4jMissingMessage());
      }

      const driver = createDriver();
      const session = neo4jSession(driver);
      try {
        const result = await session.executeRead((tx) => tx.run(query));

        const records = result.records.map((record) => {
          const obj: Record<string, unknown> = {};
          for (const key of record.keys as readonly string[]) {
            obj[key] = toPlain(record.get(key));
          }
          return obj;
        });

        return { ok: true, count: records.length, records };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Neo4j query failed: ${msg}`);
      } finally {
        await session.close();
        await driver.close();
      }
    },
  });

  // --- pm-graph neighbors --------------------------------------------------
  api.registerCommand({
    name: "pm-graph neighbors",
    description:
      "Return all 1-hop neighbors with relationships for a given node ID.",
    run: async (context) => {
      const nodeId = (context.args ?? [])[0];
      if (!nodeId) {
        throw new Error("Usage: pm pm-graph neighbors <node-id>");
      }

      if (!neo4jConfigured()) {
        throw new Error(neo4jMissingMessage());
      }

      const projectKey = projectKeyForWorkspace(getWorkspace(context));
      const driver = createDriver();
      const session = neo4jSession(driver);
      try {
        const result = await session.executeRead((tx) =>
          tx.run(
            `MATCH (center:PmGraphNode {projectKey: $projectKey, id: $nodeId})-[r]-(neighbor:PmGraphNode {projectKey: $projectKey})
             RETURN center, r, neighbor, type(r) AS relType,
                    CASE WHEN startNode(r) = center THEN 'outgoing' ELSE 'incoming' END AS direction`,
            { projectKey, nodeId },
          ),
        );

        if (result.records.length === 0) {
          return {
            ok: true,
            center: null,
            neighbors: [],
            message: `No node found with id "${nodeId}" for project "${projectKey}".`,
          };
        }

        const center = toPlain(result.records[0]!.get("center"));
        const neighbors = result.records.map((record) => ({
          node: toPlain(record.get("neighbor")),
          relationship: {
            type: record.get("relType"),
            direction: record.get("direction"),
            properties: toPlain(record.get("r")),
          },
        }));

        return { ok: true, center, neighbors };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to query neighbors: ${msg}`);
      } finally {
        await session.close();
        await driver.close();
      }
    },
  });
}

export default { activate };
