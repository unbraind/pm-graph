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
  nodes: GraphNode[];
  relationships: GraphRelationship[];
};

function getWorkspace(context: CommandContext): string {
  return context.workspaceRoot ?? context.cwd ?? process.cwd();
}

async function runPmJson<T>(context: CommandContext, args: string[]): Promise<T> {
  const { stdout } = await execFileAsync("pm", [...args, "--json"], {
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

function graphFromItems(items: PmItem[], workspace: string): Graph {
  const nodes: GraphNode[] = items.map((item) => ({
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
  }));

  const relationships: GraphRelationship[] = [];
  for (const item of items) {
    if (item.parent) {
      relationships.push({
        from: item.id,
        to: item.parent,
        type: "CHILD_OF",
        properties: { source: "parent" },
      });
    }

    for (const dep of [...(item.deps ?? []), ...(item.dependencies ?? [])]) {
      const target = relationshipTarget(dep);
      if (!target) continue;
      relationships.push({
        from: item.id,
        to: target,
        type: relationshipType(dep.type ?? dep.kind ?? dep.relation),
        properties: { ...dep },
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    workspace,
    nodes,
    relationships,
  };
}

async function loadGraph(context: CommandContext): Promise<Graph> {
  const result = await runPmJson<{ items?: PmItem[] }>(context, ["list-all"]);
  return graphFromItems(result.items ?? [], getWorkspace(context));
}

function cypherStatements(graph: Graph): Array<{ statement: string; parameters: Record<string, unknown> }> {
  const statements: Array<{ statement: string; parameters: Record<string, unknown> }> = graph.nodes.map((node) => ({
    statement: "MERGE (n:PmItem {id: $id}) SET n += $properties WITH n CALL apoc.create.addLabels(n, $labels) YIELD node RETURN node.id",
    parameters: {
      id: node.id,
      labels: node.labels.filter((label) => label !== "PmItem"),
      properties: node.properties,
    },
  }));

  for (const relationship of graph.relationships) {
    statements.push({
      statement: `MATCH (from:PmItem {id: $from}), (to:PmItem {id: $to}) MERGE (from)-[r:${relationship.type}]->(to) SET r += $properties RETURN type(r)`,
      parameters: {
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
    for (const node of graph.nodes) {
      await session.executeWrite((tx) =>
        tx.run("MERGE (n:PmItem {id: $id}) SET n += $properties RETURN n.id", {
          id: node.id,
          properties: node.properties,
        })
      );
    }

    for (const relationship of graph.relationships) {
      await session.executeWrite((tx) =>
        tx.run(
          `MATCH (from:PmItem {id: $from}), (to:PmItem {id: $to}) MERGE (from)-[r:${relationship.type}]->(to) SET r += $properties RETURN type(r)`,
          {
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
