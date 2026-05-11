import { execFile } from "node:child_process";
import { promisify } from "node:util";
import neo4j from "neo4j-driver";

const execFileAsync = promisify(execFile);

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

function getWorkspace(context: CommandContext): string {
  return context.workspaceRoot ?? context.cwd ?? process.cwd();
}

function projectKeyForWorkspace(workspace: string): string {
  return process.env.PM_GRAPH_PROJECT_KEY || workspace;
}

async function runPmJson<T>(context: CommandContext, args: string[]): Promise<T> {
  const cliEntry = process.argv[1];
  const command = cliEntry ? process.execPath : "pm";
  const commandArgs = cliEntry ? [cliEntry, ...args, "--json"] : [...args, "--json"];
  const { stdout } = await execFileAsync(command, commandArgs, {
    cwd: getWorkspace(context),
    timeout: 30_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

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

function graphFromItems(items: PmItem[], workspace: string, depsByItem: Map<string, Array<Record<string, unknown>>>): Graph {
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
    relationships: relationships.filter((relationship, index, all) =>
      all.findIndex((candidate) =>
        candidate.from === relationship.from &&
        candidate.to === relationship.to &&
        candidate.type === relationship.type
      ) === index
    ),
  };
}

async function loadGraph(context: CommandContext): Promise<Graph> {
  const result = await runPmJson<{ items?: PmItem[] }>(context, ["list-all"]);
  const items = result.items ?? [];
  const depsByItem = new Map<string, Array<Record<string, unknown>>>();
  await Promise.all(items.map(async (item) => {
    try {
      const deps = await runPmJson<unknown>(context, ["deps", item.id]);
      depsByItem.set(item.id, dependencyRows(deps));
    } catch {
      depsByItem.set(item.id, []);
    }
  }));
  return graphFromItems(items, getWorkspace(context), depsByItem);
}

function cypherStatements(graph: Graph): Array<{ statement: string; parameters: Record<string, unknown> }> {
  const statements: Array<{ statement: string; parameters: Record<string, unknown> }> = [{
    statement: "MATCH (n:PmGraphNode {projectKey: $projectKey}) DETACH DELETE n",
    parameters: { projectKey: graph.projectKey },
  }];

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

async function syncNeo4j(graph: Graph): Promise<{ syncedNodes: number; syncedRelationships: number }> {
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !user || !password) {
    throw new Error("Set NEO4J_URI, NEO4J_USER, and NEO4J_PASSWORD before running pm-graph sync.");
  }

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  const session = driver.session({ database: process.env.NEO4J_DATABASE });
  try {
    await session.executeWrite((tx) =>
      tx.run("MATCH (n:PmGraphNode {projectKey: $projectKey}) DETACH DELETE n", { projectKey: graph.projectKey })
    );

    for (const node of graph.nodes) {
      await session.executeWrite((tx) =>
        tx.run(
          "MERGE (n:PmGraphNode {projectKey: $projectKey, id: $id}) SET n += $properties, n.labels = $labels RETURN n.id",
          {
            projectKey: graph.projectKey,
            id: node.id,
            labels: node.labels,
            properties: { ...node.properties, projectKey: graph.projectKey },
          }
        )
      );
    }

    for (const relationship of graph.relationships) {
      await session.executeWrite((tx) =>
        tx.run(
          `MATCH (from:PmGraphNode {projectKey: $projectKey, id: $from}), (to:PmGraphNode {projectKey: $projectKey, id: $to}) MERGE (from)-[r:${relationship.type}]->(to) SET r += $properties RETURN type(r)`,
          {
            projectKey: graph.projectKey,
            from: relationship.from,
            to: relationship.to,
            properties: relationship.properties,
          }
        )
      );
    }
  } finally {
    await session.close();
    await driver.close();
  }

  return { syncedNodes: graph.nodes.length, syncedRelationships: graph.relationships.length };
}

export function activate(api: ExtensionApi): void {
  api.registerCommand({
    name: "pm-graph ping",
    description: "Verify that the pm-graph extension is active.",
    run: async (context) => ({
      ok: true,
      source: "pm-graph",
      command: context.command,
      neo4jConfigured: Boolean(process.env.NEO4J_URI && process.env.NEO4J_PASSWORD),
    }),
  });

  api.registerCommand({
    name: "pm-graph export",
    description: "Export the current workspace as dependency and knowledge graph JSON.",
    run: async (context) => ({
      ok: true,
      graph: await loadGraph(context),
    }),
  });

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

  api.registerCommand({
    name: "pm-graph sync",
    description: "Sync the current workspace graph into Neo4j using NEO4J_* environment variables.",
    run: async (context) => {
      const graph = await loadGraph(context);
      const result = await syncNeo4j(graph);
      return {
        ok: true,
        ...result,
      };
    },
  });
}

export default { activate };
