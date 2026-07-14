import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ImportExportContext,
  Exporter,
} from "@unbrained/pm-cli/sdk";

const execFileAsync = promisify(execFile);

const EXTENSION_VERSION = "2026.7.14";

// ---------------------------------------------------------------------------
// Error contract
// ---------------------------------------------------------------------------

// pm's extension command runtime only treats a thrown error as a cleanly
// handled non-zero exit when the error carries a numeric `exitCode` property
// (see @unbrained/pm-cli runCommandHandler). A plain `Error` makes the runtime
// fall through to its "unhandled" path, which RE-INVOKES the command handler a
// second time and exits with a generic code. We mirror the SDK's EXIT_CODE
// contract here rather than importing it: standalone-installed extensions load
// only their own `dist/`, so `@unbrained/pm-cli` is not resolvable at runtime.
const EXIT_CODE = {
  GENERIC_FAILURE: 1,
  USAGE: 2,
  NOT_FOUND: 3,
} as const;

class CommandError extends Error {
  exitCode: number;
  constructor(message: string, exitCode: number = EXIT_CODE.GENERIC_FAILURE) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
type Neo4jApi = {
  driver: (uri: string, authToken: unknown, config?: Record<string, unknown>) => unknown;
  auth: {
    basic: (user: string, password: string) => unknown;
  };
};
type Neo4jRecord = { get: (key: string) => unknown; keys: readonly string[] };
type Neo4jResult = { records: Neo4jRecord[] };
type Neo4jTransaction = {
  run: (query: string, params?: Record<string, unknown>) => Promise<Neo4jResult>;
};
type Neo4jSession = {
  close: () => Promise<void>;
  executeRead: (work: (tx: Neo4jTransaction) => Promise<unknown>) => Promise<Neo4jResult>;
  executeWrite: (work: (tx: Neo4jTransaction) => Promise<unknown>) => Promise<Neo4jResult>;
};
type Neo4jDriver = {
  session: (config?: Record<string, unknown>) => Neo4jSession;
  close: () => Promise<void>;
};

let neo4jApi: Neo4jApi | null = null;

type CommandContext = {
  command?: string;
  args?: string[];
  cwd?: string;
  workspaceRoot?: string;
};

type ExtensionCommandArgumentDefinition = {
  name: string;
  required?: boolean;
  variadic?: boolean;
  description?: string;
};

type RegisterCommand = {
  name: string;
  description: string;
  run: (context: CommandContext) => Promise<unknown>;
  arguments?: ExtensionCommandArgumentDefinition[];
  intent?: string;
  examples?: string[];
  failure_hints?: string[];
};

type ServiceOverrideContext = {
  service: string;
  command?: string;
  args?: string[];
  options?: Record<string, unknown>;
  global?: Record<string, unknown>;
  pm_root?: string;
  payload?: unknown;
};

type ExtensionApi = {
  registerCommand(command: RegisterCommand): void;
  registerExporter(name: string, exporter: Exporter): void;
  registerService(service: "output_format" | "error_format" | "help_format" | "lock_acquire" | "lock_release" | "history_append" | "item_store_write" | "item_store_delete" | "context_relevance", override: (context: ServiceOverrideContext) => unknown): void;
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

async function loadNeo4j(): Promise<Neo4jApi> {
  if (neo4jApi) return neo4jApi;
  try {
    const mod = await import("neo4j-driver");
    neo4jApi = ((mod as { default?: Neo4jApi }).default ?? mod) as Neo4jApi;
    return neo4jApi;
  } catch (err: unknown) {
    console.error("Installing pm-graph Neo4j runtime dependency...");
    const install = spawnSync("npm", ["install", "--omit=dev"], {
      cwd: packageRoot,
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "production" },
    });
    if (install.error) throw install.error;
    if (install.status !== 0) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Neo4j driver is not installed and npm install --omit=dev failed with exit code ${install.status ?? "unknown"}. (${msg})`,
      );
    }
    const mod = await import("neo4j-driver");
    neo4jApi = ((mod as { default?: Neo4jApi }).default ?? mod) as Neo4jApi;
    return neo4jApi;
  }
}

/**
 * Produce a user-friendly error message for Neo4j connection failures.
 * The neo4j-driver throws errors with codes like ServiceUnavailable or
 * AuthorizationExpired that are not helpful on their own.
 */
function neo4jFriendlyError(err: unknown): Error {
  if (!(err instanceof Error)) return new Error(String(err));

  const msg = err.message ?? "";
  const code = (err as { code?: string }).code ?? "";

  if (
    code === "ServiceUnavailable" ||
    msg.includes("Could not perform discovery") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("connect ETIMEDOUT") ||
    msg.includes("Failed to connect")
  ) {
    const uri = process.env.NEO4J_URI ?? "bolt://localhost:7687";
    return new Error(
      `Neo4j is not reachable at ${uri}. Check that Neo4j is running and NEO4J_URI is correct.`,
    );
  }

  if (
    code === "Neo.ClientError.Security.Unauthorized" ||
    msg.includes("authentication failure") ||
    msg.includes("Unauthorized")
  ) {
    return new Error(
      "Neo4j authentication failed. Check NEO4J_USER and NEO4J_PASSWORD.",
    );
  }

  return err;
}

async function createDriver(): Promise<Neo4jDriver> {
  const uri = process.env.NEO4J_URI!;
  const user = process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME!;
  const password = process.env.NEO4J_PASSWORD!;
  if (!uri || !user || !password) {
    throw new Error(neo4jMissingMessage());
  }
  const neo4j = await loadNeo4j();
  return neo4j.driver(uri, neo4j.auth.basic(user, password), {
    // Close idle connections after 5 minutes
    maxConnectionLifetime: 5 * 60 * 1000,
    // Give up acquiring a connection within 10 seconds
    connectionAcquisitionTimeout: 10_000,
    // Allow at most 10 concurrent connections per pool
    maxConnectionPoolSize: 10,
  }) as Neo4jDriver;
}

/**
 * Convert a Neo4j driver value (Integer, Node, Relationship, Path, …)
 * into a plain JSON-safe value.
 */
function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;

  // Neo4j Integer
  if ("toNumber" in value && typeof (value as { toNumber?: unknown }).toNumber === "function") {
    return (value as { toNumber: () => number }).toNumber();
  }

  // Neo4j Node
  if (
    "labels" in value &&
    Array.isArray((value as { labels?: unknown }).labels) &&
    "properties" in value &&
    typeof (value as { properties?: unknown }).properties === "object"
  ) {
    const node = value as { labels: string[]; elementId?: string; properties: Record<string, unknown> };
    return {
      _labels: node.labels,
      _elementId: node.elementId,
      ...node.properties,
    };
  }

  // Neo4j Relationship
  if (
    "type" in value &&
    "properties" in value &&
    typeof (value as { properties?: unknown }).properties === "object" &&
    ("startNodeElementId" in value || "endNodeElementId" in value)
  ) {
    const relationship = value as {
      type: string;
      elementId?: string;
      startNodeElementId?: string;
      endNodeElementId?: string;
      properties: Record<string, unknown>;
    };
    return {
      _type: relationship.type,
      _elementId: relationship.elementId,
      _startNodeElementId: relationship.startNodeElementId,
      _endNodeElementId: relationship.endNodeElementId,
      ...relationship.properties,
    };
  }

  // Neo4j Path
  if (
    "segments" in value &&
    Array.isArray((value as { segments?: unknown }).segments) &&
    "start" in value &&
    "end" in value
  ) {
    const pathValue = value as {
      start: unknown;
      end: unknown;
      segments: Array<{ start: unknown; relationship: unknown; end: unknown }>;
      length?: number;
    };
    return {
      start: toPlain(pathValue.start),
      end: toPlain(pathValue.end),
      segments: pathValue.segments.map((s) => ({
        start: toPlain(s.start),
        relationship: toPlain(s.relationship),
        end: toPlain(s.end),
      })),
      length: pathValue.length,
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

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "toNumber" in value && typeof (value as { toNumber?: unknown }).toNumber === "function") {
    return (value as { toNumber: () => number }).toNumber();
  }
  return 0;
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

/**
 * Synchronously fetch all items for a given pm root using
 * `pm --path <pm_root> list-all --json --include-body`. The `--include-body`
 * payload already carries `dependencies[]`, `blocked_by`, `tags`, and facet
 * fields, so a single call is enough to build the full graph — no per-item
 * `pm deps` round-trips are needed. Used by the exporter pipeline, where the
 * SDK provides `pm_root` (not a CommandContext `cwd`).
 */
function fetchItemsViaPath(pmRoot: string): PmItem[] {
  const result = spawnSync(
    "pm",
    ["--path", pmRoot, "list-all", "--json", "--include-body"],
    { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) {
    throw new CommandError(
      `Failed to fetch pm items (exit ${result.status ?? "unknown"}): ${
        result.stderr?.trim() || result.error?.message || "no output"
      }`,
    );
  }
  let parsed: { items?: PmItem[] };
  try {
    parsed = JSON.parse(result.stdout) as { items?: PmItem[] };
  } catch (err: unknown) {
    throw new CommandError(
      `Failed to parse pm list-all output as JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return parsed.items ?? [];
}

/**
 * Derive the logical workspace directory from a pm_root. pm roots are usually
 * `<workspace>/.agents/pm`; strip that suffix so the derived project key
 * matches what the existing `cwd`-based commands produce.
 */
function workspaceFromPmRoot(pmRoot: string): string {
  const normalized = path.resolve(pmRoot);
  const parts = normalized.split(path.sep);
  if (parts.length >= 2 && parts[parts.length - 1] === "pm" && parts[parts.length - 2] === ".agents") {
    return parts.slice(0, -2).join(path.sep) || path.sep;
  }
  return normalized;
}

/** Build a Graph directly from items already loaded via list-all --include-body. */
function loadGraphFromPath(pmRoot: string): Graph {
  const items = fetchItemsViaPath(pmRoot);
  return graphFromItems(items, workspaceFromPmRoot(pmRoot), new Map());
}

/**
 * Build a Graph for a CommandContext via a single
 * `pm list-all --json --include-body` call from the workspace cwd. The
 * `--include-body` payload already carries dependencies/blocked_by/parent/tags,
 * so no per-item `pm deps` round-trips are needed. Used by the offline
 * analytics commands (analyze/cycles/path/critical-path).
 */
function loadGraphForContext(context: CommandContext): Graph {
  const workspace = getWorkspace(context);
  const result = spawnSync(
    "pm",
    ["list-all", "--json", "--include-body"],
    { cwd: workspace, encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) {
    throw new CommandError(
      `Failed to fetch pm items (exit ${result.status ?? "unknown"}): ${
        result.stderr?.trim() || result.error?.message || "no output"
      }`,
    );
  }
  let parsed: { items?: PmItem[] };
  try {
    parsed = JSON.parse(result.stdout) as { items?: PmItem[] };
  } catch (err: unknown) {
    throw new CommandError(
      `Failed to parse pm list-all output as JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return graphFromItems(parsed.items ?? [], workspace, new Map());
}

// ---------------------------------------------------------------------------
// Analytics command flag parsing
// ---------------------------------------------------------------------------

type AnalyticsFlags = {
  json: boolean;
  includeClosed: boolean;
  root?: string;
  depth?: number;
  format: "text" | AnalysisDiagramFormat;
  filter: NodeFilter;
  positionals: string[];
};

/** Validate and normalise a `--format` value for the analysis commands. */
function parseAnalysisFormat(value: string): "text" | AnalysisDiagramFormat {
  const normalized = value.toLowerCase();
  if (
    normalized === "text" ||
    normalized === "mermaid" ||
    normalized === "graphml" ||
    normalized === "dot"
  ) {
    return normalized;
  }
  throw new CommandError(
    `Invalid --format "${value}" (expected: text | mermaid | graphml | dot).`,
    EXIT_CODE.USAGE,
  );
}

/**
 * Parse the shared analytics flags (--json, --include-closed, --root, --depth,
 * --format, --filter) and collect remaining positional arguments. Throws a USAGE
 * CommandError on a malformed --depth, an invalid --format, a malformed
 * --filter, or a value-less --root/--depth/--format/--filter.
 */
export function parseAnalyticsFlags(args: string[]): AnalyticsFlags {
  const flags: AnalyticsFlags = { json: false, includeClosed: false, format: "text", filter: [], positionals: [] };
  // Collect every --filter term first, then parse them in a single call so
  // repeated same-key flags (e.g. --filter status=open --filter status=done)
  // merge into one OR set instead of separate entries that AND to an
  // impossible condition. This mirrors the `pm-graph export` filter path.
  const filterTerms: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--include-closed") {
      flags.includeClosed = true;
    } else if (arg === "--root") {
      const value = args[++i];
      if (value === undefined) throw new CommandError("--root requires an item id.", EXIT_CODE.USAGE);
      flags.root = value;
    } else if (arg.startsWith("--root=")) {
      flags.root = arg.slice("--root=".length);
    } else if (arg === "--depth") {
      const value = args[++i];
      if (value === undefined) throw new CommandError("--depth requires an integer.", EXIT_CODE.USAGE);
      const parsed = parseInt(value, 10);
      if (Number.isNaN(parsed) || parsed < 0) {
        throw new CommandError(`Invalid --depth "${value}" (expected a non-negative integer).`, EXIT_CODE.USAGE);
      }
      flags.depth = parsed;
    } else if (arg.startsWith("--depth=")) {
      const value = arg.slice("--depth=".length);
      const parsed = parseInt(value, 10);
      if (Number.isNaN(parsed) || parsed < 0) {
        throw new CommandError(`Invalid --depth "${value}" (expected a non-negative integer).`, EXIT_CODE.USAGE);
      }
      flags.depth = parsed;
    } else if (arg === "--format") {
      const value = args[++i];
      if (value === undefined) throw new CommandError("--format requires a value (text | mermaid | graphml | dot).", EXIT_CODE.USAGE);
      flags.format = parseAnalysisFormat(value);
    } else if (arg.startsWith("--format=")) {
      flags.format = parseAnalysisFormat(arg.slice("--format=".length));
    } else if (arg === "--filter") {
      const value = args[++i];
      if (value === undefined) throw new CommandError("--filter requires a value (type=... | status=...).", EXIT_CODE.USAGE);
      filterTerms.push(value);
    } else if (arg.startsWith("--filter=")) {
      filterTerms.push(arg.slice("--filter=".length));
    } else if (arg === "--help" || arg === "-h") {
      // handled separately by hasHelpFlag
    } else if (arg.startsWith("--")) {
      // ignore unknown flags rather than misparse them as positionals
    } else {
      flags.positionals.push(arg);
    }
  }
  flags.filter = parseNodeFilter(filterTerms);
  return flags;
}

/**
 * Load a graph for a context and apply the shared analytics shaping
 * (structural edges only is enforced downstream; here we only honor
 * --include-closed and an optional --root/--depth neighborhood). Throws
 * NOT_FOUND when --root cannot be resolved to a unique workspace item id.
 */
function shapedAnalyticsGraph(context: CommandContext, flags: AnalyticsFlags): Graph {
  const full = loadGraphForContext(context);
  const resolvedRoot = flags.root
    ? resolveItemIdOrThrow([...itemNodeIds(full)].sort(), flags.root, "--root node").resolved
    : undefined;
  // Restrict to structural edges so neighborhood shaping follows dependencies,
  // not facet/tag links. The analytics functions also re-filter defensively.
  return shapeGraph(full, {
    edges: "deps",
    includeClosed: flags.includeClosed,
    rootId: resolvedRoot,
    depth: flags.depth,
    filter: flags.filter,
  });
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
// Multi-format export (pm graph export)
// ---------------------------------------------------------------------------

export type ExportFormat = "cypher" | "mermaid" | "dot" | "json" | "graphml" | "plantuml";
export type EdgeFilter = "deps" | "tags" | "all";

/** A single `--filter` term: keep PmItem nodes whose `key` property is one of `values`. */
export type NodeFilterEntry = { key: "type" | "status"; values: string[] };
/** Node filter (AND across entries, OR within an entry's values). */
export type NodeFilter = NodeFilterEntry[];

const NODE_FILTER_KEYS = new Set(["type", "status"]);

/**
 * Parse one or more `key=value[,value]` filter terms into a NodeFilter.
 * Throws a USAGE CommandError on a missing `=`, an unsupported key, or an
 * empty value list. Values are matched case-insensitively.
 */
export function parseNodeFilter(raw: string[]): NodeFilter {
  const byKey = new Map<NodeFilterEntry["key"], Set<string>>();
  for (const term of raw) {
    const eq = term.indexOf("=");
    if (eq <= 0) {
      throw new CommandError(
        `Invalid --filter "${term}" (expected key=value, e.g. type=Task or status=open,done).`,
        EXIT_CODE.USAGE,
      );
    }
    const key = term.slice(0, eq).trim().toLowerCase();
    const valuePart = term.slice(eq + 1).trim();
    if (!NODE_FILTER_KEYS.has(key)) {
      throw new CommandError(
        `Invalid --filter key "${key}" (supported keys: type, status).`,
        EXIT_CODE.USAGE,
      );
    }
    const values = valuePart
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.length > 0);
    if (values.length === 0) {
      throw new CommandError(
        `Invalid --filter "${term}" (expected at least one value after "=").`,
        EXIT_CODE.USAGE,
      );
    }
    const typedKey = key as NodeFilterEntry["key"];
    const merged = byKey.get(typedKey) ?? new Set<string>();
    for (const value of values) merged.add(value);
    byKey.set(typedKey, merged);
  }
  return [...byKey].map(([key, values]) => ({ key, values: [...values] }));
}

/**
 * Whether a node survives a NodeFilter. Non-PmItem nodes (facets, tags,
 * external items) always survive — the filter scopes workspace *items* only.
 * For PmItem nodes, every entry must match (AND); an entry matches when the
 * node's (lowercased) `key` property is one of the entry's values (OR).
 */
export function matchesNodeFilter(node: GraphNode, filter: NodeFilter): boolean {
  if (filter.length === 0) return true;
  if (!node.labels.includes("PmItem")) return true;
  for (const entry of filter) {
    const raw = node.properties[entry.key];
    const value = typeof raw === "string" ? raw.toLowerCase() : "";
    if (!entry.values.includes(value)) return false;
  }
  return true;
}

// Relationships generated from item metadata facets (type/status/assignee/...).
const FACET_REL_TYPES = new Set([
  "HAS_TYPE",
  "HAS_STATUS",
  "ASSIGNED_TO",
  "IN_SPRINT",
  "IN_RELEASE",
]);
const TAG_REL_TYPE = "TAGGED_WITH";

/** Classify which relationship types survive a given --edges filter. */
function edgeAllowed(type: string, filter: EdgeFilter): boolean {
  if (filter === "all") return true;
  if (filter === "tags") return type === TAG_REL_TYPE;
  // "deps": structural/dependency edges only (drop facet + tag edges)
  return type !== TAG_REL_TYPE && !FACET_REL_TYPES.has(type);
}

/**
 * Restrict a graph to the connected neighborhood of `rootId` within `depth`
 * hops (treating relationships as undirected for reachability), and optionally
 * drop closed items. Returns a new graph with consistently pruned nodes and
 * relationships. When `rootId` is undefined, only the edge/closed filters
 * apply.
 */
function shapeGraph(
  graph: Graph,
  opts: { edges: EdgeFilter; includeClosed: boolean; rootId?: string; depth?: number; filter?: NodeFilter },
): Graph {
  // 1. Filter relationships by the --edges selector first.
  let relationships = graph.relationships.filter((r) => edgeAllowed(r.type, opts.edges));

  // 2. Optionally drop PmItem nodes that fail --filter type=.../status=... and/or
  // closed/canceled items (facets/external nodes are kept). Both selectors feed
  // a single `dropped` set so their node/edge pruning happens in one pass.
  const dropped = new Set<string>();
  let nodes = graph.nodes;
  if (opts.filter && opts.filter.length > 0) {
    for (const node of graph.nodes) {
      if (!matchesNodeFilter(node, opts.filter)) {
        dropped.add(node.id);
      }
    }
  }
  if (!opts.includeClosed) {
    for (const node of graph.nodes) {
      const status = node.properties.status;
      const isItem = node.labels.includes("PmItem");
      if (isItem && typeof status === "string" && (status === "closed" || status === "canceled")) {
        dropped.add(node.id);
      }
    }
  }
  if (dropped.size > 0) {
    nodes = nodes.filter((n) => !dropped.has(n.id));
    relationships = relationships.filter((r) => !dropped.has(r.from) && !dropped.has(r.to));
  }

  // 3. Neighborhood restriction from --root within --depth hops (undirected).
  if (opts.rootId) {
    const adjacency = new Map<string, Set<string>>();
    for (const r of relationships) {
      (adjacency.get(r.from) ?? adjacency.set(r.from, new Set()).get(r.from)!).add(r.to);
      (adjacency.get(r.to) ?? adjacency.set(r.to, new Set()).get(r.to)!).add(r.from);
    }
    const maxDepth = opts.depth ?? Infinity;
    const reachable = new Set<string>();
    const queue: Array<{ id: string; d: number }> = [{ id: opts.rootId, d: 0 }];
    reachable.add(opts.rootId);
    while (queue.length > 0) {
      const { id, d } = queue.shift()!;
      if (d >= maxDepth) continue;
      for (const next of adjacency.get(id) ?? []) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push({ id: next, d: d + 1 });
        }
      }
    }
    nodes = nodes.filter((n) => reachable.has(n.id));
    relationships = relationships.filter((r) => reachable.has(r.from) && reachable.has(r.to));
  }

  return { ...graph, nodes, relationships };
}

/** Escape a string for a Mermaid node label inside `["..."]`. */
function mermaidLabel(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/\n/g, " ").trim();
}

/** Mermaid node ids must be alphanumeric/underscore. */
function mermaidId(id: string): string {
  return "n_" + id.replace(/[^A-Za-z0-9_]/g, "_");
}

function renderMermaid(graph: Graph): string {
  const lines: string[] = ["graph TD"];
  for (const node of graph.nodes) {
    const title = typeof node.properties.title === "string" && node.properties.title
      ? String(node.properties.title)
      : node.id;
    const status = typeof node.properties.status === "string" ? node.properties.status : "";
    const label = status ? `${title} [${node.id}] (${status})` : `${title} [${node.id}]`;
    lines.push(`  ${mermaidId(node.id)}["${mermaidLabel(label)}"]`);
  }
  if (graph.relationships.length > 0) lines.push("");
  for (const rel of graph.relationships) {
    lines.push(`  ${mermaidId(rel.from)} -->|${mermaidLabel(rel.type)}| ${mermaidId(rel.to)}`);
  }
  return lines.join("\n");
}

/** Escape a string for a Graphviz double-quoted attribute. */
function dotEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderDot(graph: Graph): string {
  const lines: string[] = ["digraph pm_graph {", "  rankdir=LR;", '  node [shape=box, style=rounded];'];
  for (const node of graph.nodes) {
    const title = typeof node.properties.title === "string" && node.properties.title
      ? String(node.properties.title)
      : node.id;
    const status = typeof node.properties.status === "string" ? node.properties.status : "";
    // Build the second line first, then join with the DOT line-break directive
    // "\n" AFTER escaping so dotEscape does not double-escape the backslash.
    const second = status ? `[${node.id}] ${status}` : `[${node.id}]`;
    const label = `${dotEscape(title)}\\n${dotEscape(second)}`;
    lines.push(`  "${dotEscape(node.id)}" [label="${label}"];`);
  }
  for (const rel of graph.relationships) {
    lines.push(`  "${dotEscape(rel.from)}" -> "${dotEscape(rel.to)}" [label="${dotEscape(rel.type)}"];`);
  }
  lines.push("}");
  return lines.join("\n");
}

/** A JSON Graph Format-style document (nodes/edges) for generic graph tooling. */
function renderJsonGraph(graph: Graph): string {
  const doc = {
    graph: {
      directed: true,
      type: "pm-graph",
      metadata: {
        generatedAt: graph.generatedAt,
        workspace: graph.workspace,
        projectKey: graph.projectKey,
      },
      nodes: graph.nodes.map((node) => ({
        id: node.id,
        label: typeof node.properties.title === "string" ? node.properties.title : node.id,
        labels: node.labels,
        metadata: node.properties,
      })),
      edges: graph.relationships.map((rel) => ({
        source: rel.from,
        target: rel.to,
        relation: rel.type,
        metadata: rel.properties,
      })),
    },
  };
  return JSON.stringify(doc, null, 2);
}

/** Escape a string for XML text/attribute content. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Render a valid GraphML XML document (consumable by yEd / Gephi / NetworkX).
 * Declares string keys for node title/type/status/labels and edge type, then
 * emits one <node> per graph node and one <edge> per relationship.
 */
export function renderGraphml(graph: Graph): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">',
  );
  lines.push('  <key id="title" for="node" attr.name="title" attr.type="string"/>');
  lines.push('  <key id="type" for="node" attr.name="type" attr.type="string"/>');
  lines.push('  <key id="status" for="node" attr.name="status" attr.type="string"/>');
  lines.push('  <key id="labels" for="node" attr.name="labels" attr.type="string"/>');
  lines.push('  <key id="reltype" for="edge" attr.name="reltype" attr.type="string"/>');
  lines.push('  <graph id="pm-graph" edgedefault="directed">');
  for (const node of graph.nodes) {
    const title = typeof node.properties.title === "string" && node.properties.title
      ? String(node.properties.title)
      : node.id;
    const type = typeof node.properties.type === "string" ? node.properties.type : "";
    const status = typeof node.properties.status === "string" ? node.properties.status : "";
    lines.push(`    <node id="${xmlEscape(node.id)}">`);
    lines.push(`      <data key="title">${xmlEscape(title)}</data>`);
    if (type) lines.push(`      <data key="type">${xmlEscape(type)}</data>`);
    if (status) lines.push(`      <data key="status">${xmlEscape(status)}</data>`);
    lines.push(`      <data key="labels">${xmlEscape(node.labels.join(" "))}</data>`);
    lines.push("    </node>");
  }
  graph.relationships.forEach((rel, index) => {
    lines.push(
      `    <edge id="e${index}" source="${xmlEscape(rel.from)}" target="${xmlEscape(rel.to)}">`,
    );
    lines.push(`      <data key="reltype">${xmlEscape(rel.type)}</data>`);
    lines.push("    </edge>");
  });
  lines.push("  </graph>");
  lines.push("</graphml>");
  return lines.join("\n");
}

/** Sanitise an id for use as a PlantUML alias (alphanumeric/underscore). */
function plantumlAlias(id: string): string {
  return "n_" + id.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Escape a string for a PlantUML double-quoted label. */
function plantumlLabel(s: string): string {
  return s.replace(/"/g, "'").replace(/\n/g, " ").trim();
}

/**
 * Render a PlantUML object diagram (`@startuml`…`@enduml`) with one object per
 * node and one arrow per relationship, the relationship type as the arrow
 * label. Renders with PlantUML / Structurizr / many docs toolchains.
 */
export function renderPlantuml(graph: Graph): string {
  const lines: string[] = ["@startuml", "left to right direction"];
  for (const node of graph.nodes) {
    const title = typeof node.properties.title === "string" && node.properties.title
      ? String(node.properties.title)
      : node.id;
    const status = typeof node.properties.status === "string" ? node.properties.status : "";
    const label = status ? `${title} [${node.id}] (${status})` : `${title} [${node.id}]`;
    lines.push(`object "${plantumlLabel(label)}" as ${plantumlAlias(node.id)}`);
  }
  if (graph.relationships.length > 0) lines.push("");
  for (const rel of graph.relationships) {
    lines.push(`${plantumlAlias(rel.from)} --> ${plantumlAlias(rel.to)} : ${plantumlLabel(rel.type)}`);
  }
  lines.push("@enduml");
  return lines.join("\n");
}

function renderExport(format: ExportFormat, graph: Graph): string {
  switch (format) {
    case "cypher":
      return cypherStatements(graph)
        .map((s) => `// params: ${JSON.stringify(s.parameters)}\n${s.statement};`)
        .join("\n");
    case "mermaid":
      return renderMermaid(graph);
    case "dot":
      return renderDot(graph);
    case "json":
      return renderJsonGraph(graph);
    case "graphml":
      return renderGraphml(graph);
    case "plantuml":
      return renderPlantuml(graph);
  }
}

function readExportOption(options: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = options[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Graph analytics (offline — operate on STRUCTURAL edges only)
// ---------------------------------------------------------------------------

// Analytics treat the workspace as a directed dependency graph. Only
// *structural* edges (BLOCKED_BY + CHILD_OF + dependency edges such as BLOCKS /
// RELATED) participate. Facet edges (HAS_TYPE/HAS_STATUS/ASSIGNED_TO/IN_SPRINT/
// IN_RELEASE) and tag edges (TAGGED_WITH) are metadata, not dependencies — if
// they were included, every item sharing a status or tag would appear linked,
// producing meaningless cycles, components, and centrality. Filtering to
// structural edges keeps cycle/path/critical-path results semantically honest.
function isStructuralEdge(type: string): boolean {
  return type !== TAG_REL_TYPE && !FACET_REL_TYPES.has(type);
}

/** Item-only node ids (drop facet/tag/external nodes that are not PmItems). */
function itemNodeIds(graph: Graph): Set<string> {
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (node.labels.includes("PmItem")) ids.add(node.id);
  }
  return ids;
}

type StructuralEdge = { from: string; to: string; type: string };

/** Extract the directed structural edges of a graph, between item nodes only. */
function structuralEdges(graph: Graph): StructuralEdge[] {
  const items = itemNodeIds(graph);
  const seen = new Set<string>();
  const edges: StructuralEdge[] = [];
  for (const rel of graph.relationships) {
    if (!isStructuralEdge(rel.type)) continue;
    if (!items.has(rel.from) || !items.has(rel.to)) continue;
    const key = `${rel.from}->${rel.to}:${rel.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: rel.from, to: rel.to, type: rel.type });
  }
  return edges;
}

/** Directed adjacency (from -> [to]) over a set of edges. */
function buildAdjacency(edges: StructuralEdge[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.from) ?? [];
    if (!list.includes(e.to)) list.push(e.to);
    adjacency.set(e.from, list);
  }
  return adjacency;
}

/**
 * Detect all elementary directed cycles among structural edges using an
 * iterative DFS with a recursion stack. Returns each cycle as an ordered id
 * path whose first and last ids are equal (e.g. [E, F, E]). Cycles are
 * de-duplicated by their canonical rotation so A->B->A and B->A->B collapse.
 */
export function findCycles(nodes: string[], edges: StructuralEdge[]): string[][] {
  const adjacency = buildAdjacency(edges);
  const cycles: string[][] = [];
  const seenCanonical = new Set<string>();

  const canonical = (cycle: string[]): string => {
    // cycle excludes the repeated closing node; rotate to start at min id.
    const core = cycle.slice(0, -1);
    let minIdx = 0;
    for (let i = 1; i < core.length; i++) {
      if (core[i] < core[minIdx]) minIdx = i;
    }
    const rotated = [...core.slice(minIdx), ...core.slice(0, minIdx)];
    return rotated.join("->");
  };

  for (const start of nodes) {
    // Iterative DFS carrying the current path; detect back-edges to a node
    // already on the path (a cycle), or revisits handled via path membership.
    const stack: Array<{ node: string; path: string[]; onPath: Set<string> }> = [
      { node: start, path: [start], onPath: new Set([start]) },
    ];
    while (stack.length > 0) {
      const { node, path: currentPath, onPath } = stack.pop()!;
      for (const next of adjacency.get(node) ?? []) {
        if (next === start && currentPath.length >= 1) {
          // Closed a cycle back to the start node.
          const cycle = [...currentPath, start];
          const key = canonical(cycle);
          if (!seenCanonical.has(key)) {
            seenCanonical.add(key);
            cycles.push(cycle);
          }
          continue;
        }
        // Only extend along nodes greater than start to avoid re-finding
        // cycles rooted at smaller ids, and never revisit a node on this path.
        if (next < start || onPath.has(next)) continue;
        const nextOnPath = new Set(onPath);
        nextOnPath.add(next);
        stack.push({ node: next, path: [...currentPath, next], onPath: nextOnPath });
      }
    }
  }

  return cycles;
}

/**
 * Shortest directed path from `from` to `to` over structural edges (BFS).
 * Returns the ordered id path (inclusive of both endpoints) or null if no path
 * exists. Returns [from] when from === to.
 */
export function shortestPath(
  edges: StructuralEdge[],
  from: string,
  to: string,
): string[] | null {
  if (from === to) return [from];
  const adjacency = buildAdjacency(edges);
  const visited = new Set<string>([from]);
  const queue: string[] = [from];
  const prev = new Map<string, string>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const next of adjacency.get(node) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      prev.set(next, node);
      if (next === to) {
        const path: string[] = [to];
        let cur = to;
        while (prev.has(cur)) {
          cur = prev.get(cur)!;
          path.unshift(cur);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

/**
 * Longest dependency chain (critical path) over structural edges. Uses a
 * memoised DFS that is safe on cyclic graphs (nodes on the active recursion
 * stack are skipped, so a cycle cannot inflate the chain infinitely). Returns
 * the ordered id list of the longest simple chain found.
 */
export function longestChain(nodes: string[], edges: StructuralEdge[]): string[] {
  const adjacency = buildAdjacency(edges);
  const memo = new Map<string, string[]>();
  const onStack = new Set<string>();

  const dfs = (node: string): string[] => {
    const cached = memo.get(node);
    if (cached) return cached;
    onStack.add(node);
    let best: string[] = [];
    for (const next of adjacency.get(node) ?? []) {
      if (onStack.has(next)) continue; // skip back-edges (cycle safety)
      const candidate = dfs(next);
      if (candidate.length > best.length) best = candidate;
    }
    onStack.delete(node);
    const result = [node, ...best];
    memo.set(node, result);
    return result;
  };

  let longest: string[] = [];
  for (const node of nodes) {
    const chain = dfs(node);
    if (chain.length > longest.length) longest = chain;
  }
  return longest;
}

/**
 * Topological execution order over structural edges using Kahn's algorithm.
 *
 * Edges point from an item to its blocker/dependency (e.g. B --BLOCKED_BY--> A
 * means "B is blocked by A", so A must be done before B). A valid execution
 * order therefore lists a node only after every node it points to. We compute
 * that order by treating out-edges as prerequisites: repeatedly emit nodes whose
 * out-degree (unsatisfied prerequisites) has dropped to zero.
 *
 * Returns `{ order, cycleNodes }`. When the graph is acyclic, `order` contains
 * every node and `cycleNodes` is empty. When a cycle exists, the nodes that
 * could not be ordered are returned in `cycleNodes` (and `order` holds the
 * resolvable prefix). Ties are broken by ascending id for deterministic output.
 */
export function topoSort(
  nodes: string[],
  edges: StructuralEdge[],
): { order: string[]; cycleNodes: string[] } {
  // Prerequisites of a node = the distinct nodes it points to (its blockers).
  const prereqs = new Map<string, Set<string>>();
  // Dependents: for each prerequisite, which nodes wait on it.
  const dependents = new Map<string, string[]>();
  const nodeSet = new Set(nodes);
  for (const id of nodes) prereqs.set(id, new Set());
  for (const e of edges) {
    if (!nodeSet.has(e.from) || !nodeSet.has(e.to)) continue;
    if (e.from === e.to) continue; // self-loop is its own cycle, handled below
    const set = prereqs.get(e.from)!;
    if (!set.has(e.to)) {
      set.add(e.to);
      (dependents.get(e.to) ?? dependents.set(e.to, []).get(e.to)!).push(e.from);
    }
  }

  // Seed the ready queue with nodes that have no prerequisites.
  const ready = nodes.filter((id) => prereqs.get(id)!.size === 0).sort();
  const order: string[] = [];
  const remaining = new Map<string, number>();
  for (const id of nodes) remaining.set(id, prereqs.get(id)!.size);

  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    let inserted = false;
    for (const dep of dependents.get(id) ?? []) {
      const left = (remaining.get(dep) ?? 0) - 1;
      remaining.set(dep, left);
      if (left === 0) {
        // Insert keeping the ready queue sorted for deterministic output.
        const idx = ready.findIndex((x) => x > dep);
        if (idx === -1) ready.push(dep);
        else ready.splice(idx, 0, dep);
        inserted = true;
      }
    }
    void inserted;
  }

  // Any node never emitted is part of (or downstream of) a cycle.
  const ordered = new Set(order);
  const cycleNodes = nodes.filter((id) => !ordered.has(id)).sort();
  return { order, cycleNodes };
}

/**
 * Reverse-reachable set from `start` over structural edges: every node that can
 * reach `start` by following edge direction (i.e. everything transitively
 * blocked-by / downstream of `start`). With edges pointing item -> blocker, the
 * dependents of X are the nodes with an edge INTO X, so we walk edges backwards
 * via a reverse adjacency (BFS). Excludes `start` itself. Result is sorted.
 */
export function reverseReachable(edges: StructuralEdge[], start: string): string[] {
  const reverse = new Map<string, string[]>();
  for (const e of edges) {
    (reverse.get(e.to) ?? reverse.set(e.to, []).get(e.to)!).push(e.from);
  }
  const seen = new Set<string>();
  const queue: string[] = [start];
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const prev of reverse.get(node) ?? []) {
      if (prev === start || seen.has(prev)) continue;
      seen.add(prev);
      queue.push(prev);
    }
  }
  return [...seen].sort();
}

/**
 * Longest-path depth per node: the number of edges on the longest directed
 * structural path STARTING at the node (its distance to a leaf along blocker
 * edges). A leaf (no outgoing edge) has depth 0. Cycle-safe: nodes on the active
 * recursion stack are skipped so a cycle cannot inflate depth infinitely. This
 * is the "longest path from any root" metric expressed per node, since the
 * deepest node is exactly the far end of the critical path.
 */
export function dependencyDepths(
  nodes: string[],
  edges: StructuralEdge[],
): Map<string, number> {
  const adjacency = buildAdjacency(edges);
  const memo = new Map<string, number>();
  const onStack = new Set<string>();

  const dfs = (node: string): number => {
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    onStack.add(node);
    let best = 0;
    for (const next of adjacency.get(node) ?? []) {
      if (onStack.has(next)) continue; // cycle safety
      const candidate = 1 + dfs(next);
      if (candidate > best) best = candidate;
    }
    onStack.delete(node);
    memo.set(node, best);
    return best;
  };

  const depths = new Map<string, number>();
  for (const node of nodes) depths.set(node, dfs(node));
  return depths;
}

export function criticalConnectors(
  nodes: string[],
  edges: StructuralEdge[],
): {
  articulationPoints: string[];
  bridges: Array<{ from: string; to: string }>;
} {
  const nodeSet = new Set(nodes);
  const adjacency = new Map<string, Set<string>>();
  for (const id of nodes) adjacency.set(id, new Set());
  for (const edge of edges) {
    if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to) || edge.from === edge.to) continue;
    adjacency.get(edge.from)?.add(edge.to);
    adjacency.get(edge.to)?.add(edge.from);
  }

  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const articulation = new Set<string>();
  const bridges: Array<{ from: string; to: string }> = [];
  let time = 0;

  const visit = (u: string): void => {
    disc.set(u, ++time);
    low.set(u, disc.get(u)!);
    let childCount = 0;

    for (const v of [...(adjacency.get(u) ?? [])].sort()) {
      if (!disc.has(v)) {
        parent.set(v, u);
        childCount++;
        visit(v);
        low.set(u, Math.min(low.get(u)!, low.get(v)!));

        const uParent = parent.get(u) ?? null;
        if (uParent === null && childCount > 1) articulation.add(u);
        if (uParent !== null && low.get(v)! >= disc.get(u)!) articulation.add(u);
        if (low.get(v)! > disc.get(u)!) {
          const [from, to] = [u, v].sort();
          bridges.push({ from, to });
        }
      } else if (v !== parent.get(u)) {
        low.set(u, Math.min(low.get(u)!, disc.get(v)!));
      }
    }
  };

  for (const id of [...nodes].sort()) {
    if (!disc.has(id)) {
      parent.set(id, null);
      visit(id);
    }
  }

  bridges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return {
    articulationPoints: [...articulation].sort(),
    bridges,
  };
}

// ---------------------------------------------------------------------------
// Analysis subgraph extraction (for diagram export of cycles / critical-path)
// ---------------------------------------------------------------------------

/** Diagram output formats supported by the analysis commands. */
export type AnalysisDiagramFormat = "mermaid" | "graphml" | "dot";

/**
 * Project a subgraph of `graph` containing exactly the nodes in `nodeIds` (in
 * the order given, de-duplicated) and exactly the relationships identified by
 * `edgeKeys` (each `${from}->${to}`). Node properties/labels and relationship
 * properties are preserved verbatim from the source graph so the existing
 * renderers (renderMermaid / renderGraphml) produce labelled output. Edge keys
 * that have no matching relationship in the source graph are skipped, so the
 * subgraph never invents edges.
 */
export function projectSubgraph(
  graph: Graph,
  nodeIds: string[],
  edgeKeys: string[],
): Graph {
  const wanted = new Set(nodeIds);
  const seenNode = new Set<string>();
  const nodesById = new Map<string, GraphNode>();
  for (const node of graph.nodes) nodesById.set(node.id, node);
  const nodes: GraphNode[] = [];
  for (const id of nodeIds) {
    if (seenNode.has(id)) continue;
    seenNode.add(id);
    const found = nodesById.get(id);
    // Synthesize a minimal node if the source graph lacks it (defensive: keeps
    // the diagram complete for ids that came from analytics but were pruned).
    nodes.push(found ?? { id, labels: ["PmItem"], properties: { id, title: id } });
  }

  const keySet = new Set(edgeKeys);
  const usedKey = new Set<string>();
  const relationships: GraphRelationship[] = [];
  for (const rel of graph.relationships) {
    if (!isStructuralEdge(rel.type)) continue;
    if (!wanted.has(rel.from) || !wanted.has(rel.to)) continue;
    const key = `${rel.from}->${rel.to}`;
    if (!keySet.has(key) || usedKey.has(key)) continue;
    usedKey.add(key);
    relationships.push(rel);
  }

  return { ...graph, nodes, relationships };
}

/**
 * Build the subgraph for a critical-path `chain` (an ordered id list): the
 * chain nodes plus the consecutive edges that connect them.
 */
export function criticalPathSubgraph(graph: Graph, chain: string[]): Graph {
  const edgeKeys: string[] = [];
  for (let i = 0; i < chain.length - 1; i++) {
    edgeKeys.push(`${chain[i]}->${chain[i + 1]}`);
  }
  return projectSubgraph(graph, chain, edgeKeys);
}

/**
 * Build the subgraph for a set of detected `cycles` (each a closed id path
 * whose first === last): the union of all participating nodes plus the
 * consecutive edges around every cycle. Node order is the first-seen order
 * across cycles for deterministic output.
 */
export function cyclesSubgraph(graph: Graph, cycles: string[][]): Graph {
  const nodeOrder: string[] = [];
  const seen = new Set<string>();
  const edgeKeys: string[] = [];
  for (const cycle of cycles) {
    for (const id of cycle) {
      if (!seen.has(id)) {
        seen.add(id);
        nodeOrder.push(id);
      }
    }
    for (let i = 0; i < cycle.length - 1; i++) {
      edgeKeys.push(`${cycle[i]}->${cycle[i + 1]}`);
    }
  }
  return projectSubgraph(graph, nodeOrder, edgeKeys);
}

/** Render an analysis subgraph via the existing full-graph renderers. */
export function renderAnalysisDiagram(format: AnalysisDiagramFormat, graph: Graph): string {
  if (format === "mermaid") return renderMermaid(graph);
  if (format === "dot") return renderDot(graph);
  return renderGraphml(graph);
}

type AnalyzeReport = {
  workspace: string;
  projectKey: string;
  itemCount: number;
  structuralEdgeCount: number;
  cycleCount: number;
  cycles: string[][];
  orphanCount: number;
  orphans: string[];
  rootCount: number;
  roots: string[];
  leafCount: number;
  leaves: string[];
  longestChainLength: number;
  longestChain: string[];
  connectedComponents: number;
  blockedItemCount: number;
  blockedItems: string[];
  topDegreeCentrality: Array<{ id: string; degree: number; inDegree: number; outDegree: number }>;
  maxDepth: number;
  depthByItem: Array<{ id: string; depth: number }>;
  articulationPointCount: number;
  articulationPoints: string[];
  bridgeEdgeCount: number;
  bridgeEdges: Array<{ from: string; to: string }>;
};

export type ExplainNeighbor = {
  id: string;
  title: string;
  status: string | null;
  relationTypes: string[];
};

export type ExplainReport = {
  id: string;
  item: {
    id: string;
    title: string;
    type: string;
    status: string;
    priority: number | null;
    assignee: string | null;
    sprint: string | null;
    release: string | null;
    deadline: string | null;
  };
  blockers: ExplainNeighbor[];
  dependents: ExplainNeighbor[];
  transitiveDependents: string[];
  dependencyDepth: number;
  criticalChainFromItem: string[];
  inCycle: boolean;
  cycleCount: number;
  cycles: string[][];
};

function readStringProperty(
  properties: Record<string, unknown>,
  key: string,
): string | null {
  const value = properties[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNumberProperty(
  properties: Record<string, unknown>,
  key: string,
): number | null {
  const value = properties[key];
  if (typeof value === "number") return value;
  if (
    value &&
    typeof value === "object" &&
    "toNumber" in value &&
    typeof (value as { toNumber?: unknown }).toNumber === "function"
  ) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return null;
}

function itemTitle(node: GraphNode | undefined, fallbackId: string): string {
  if (!node) return fallbackId;
  const title = readStringProperty(node.properties, "title");
  return title ?? node.id;
}

function itemStatus(node: GraphNode | undefined): string | null {
  if (!node) return null;
  return readStringProperty(node.properties, "status");
}

function itemNodeMap(graph: Graph): Map<string, GraphNode> {
  const map = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (node.labels.includes("PmItem")) map.set(node.id, node);
  }
  return map;
}

/**
 * Build a focused, agent-friendly report for a single item id:
 * immediate blockers/dependents, transitive impact, depth, critical chain
 * from the item, and cycle participation.
 */
export function explainItem(graph: Graph, id: string): ExplainReport | null {
  const items = [...itemNodeIds(graph)].sort();
  if (!items.includes(id)) return null;

  const edges = structuralEdges(graph);
  const nodesById = itemNodeMap(graph);
  const node = nodesById.get(id);
  if (!node) return null;

  const blockerTypes = new Map<string, Set<string>>();
  const dependentTypes = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.from === id) {
      (blockerTypes.get(edge.to) ?? blockerTypes.set(edge.to, new Set()).get(edge.to)!).add(edge.type);
    }
    if (edge.to === id) {
      (dependentTypes.get(edge.from) ?? dependentTypes.set(edge.from, new Set()).get(edge.from)!).add(edge.type);
    }
  }

  const mapNeighbors = (index: Map<string, Set<string>>): ExplainNeighbor[] =>
    [...index.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([neighborId, types]) => ({
        id: neighborId,
        title: itemTitle(nodesById.get(neighborId), neighborId),
        status: itemStatus(nodesById.get(neighborId)),
        relationTypes: [...types].sort(),
      }));

  const depths = dependencyDepths(items, edges);
  const cycles = findCycles(items, edges).filter((cycle) => cycle.includes(id));

  return {
    id,
    item: {
      id: node.id,
      title: itemTitle(node, id),
      type: readStringProperty(node.properties, "type") ?? "Item",
      status: readStringProperty(node.properties, "status") ?? "unknown",
      priority: readNumberProperty(node.properties, "priority"),
      assignee: readStringProperty(node.properties, "assignee"),
      sprint: readStringProperty(node.properties, "sprint"),
      release: readStringProperty(node.properties, "release"),
      deadline: readStringProperty(node.properties, "deadline"),
    },
    blockers: mapNeighbors(blockerTypes),
    dependents: mapNeighbors(dependentTypes),
    transitiveDependents: reverseReachable(edges, id),
    dependencyDepth: depths.get(id) ?? 0,
    criticalChainFromItem: longestChain([id], edges),
    inCycle: cycles.length > 0,
    cycleCount: cycles.length,
    cycles,
  };
}

function sharedPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function suggestItemIds(itemIds: string[], input: string, limit: number = 5): string[] {
  const query = input.trim().toLowerCase();
  if (!query) return [];
  return itemIds
    .map((id) => {
      const value = id.toLowerCase();
      const startsWith = value.startsWith(query);
      const includes = value.includes(query);
      const sharedPrefix = sharedPrefixLength(value, query);
      return { id, startsWith, includes, sharedPrefix };
    })
    .filter((candidate) => candidate.includes || candidate.sharedPrefix >= 3)
    .sort((a, b) =>
      Number(b.startsWith) - Number(a.startsWith) ||
      Number(b.includes) - Number(a.includes) ||
      b.sharedPrefix - a.sharedPrefix ||
      a.id.localeCompare(b.id)
    )
    .slice(0, limit)
    .map((candidate) => candidate.id);
}

type ItemIdResolution = {
  input: string;
  resolved: string;
  strategy: "exact" | "case-insensitive" | "prefix";
};

function ambiguousItemIdError(label: string, input: string, matches: string[]): CommandError {
  const shown = matches.slice(0, 5);
  const more = matches.length > shown.length ? ` (+${matches.length - shown.length} more)` : "";
  return new CommandError(
    `${label} "${input}" is ambiguous in the workspace graph. Matches: ${shown.join(", ")}${more}. Use a longer prefix or the full id.`,
    EXIT_CODE.NOT_FOUND,
  );
}

function resolveItemIdOrThrow(itemIds: string[], input: string, label: string): ItemIdResolution {
  const requested = input.trim();
  const ids = [...new Set(itemIds)].sort((a, b) => a.localeCompare(b));

  if (ids.includes(requested)) {
    return { input: requested, resolved: requested, strategy: "exact" };
  }

  const query = requested.toLowerCase();
  const caseInsensitive = ids.filter((id) => id.toLowerCase() === query);
  if (caseInsensitive.length === 1) {
    return { input: requested, resolved: caseInsensitive[0], strategy: "case-insensitive" };
  }
  if (caseInsensitive.length > 1) {
    throw ambiguousItemIdError(label, requested, caseInsensitive);
  }

  const prefix = ids.filter((id) => id.toLowerCase().startsWith(query));
  if (prefix.length === 1) {
    return { input: requested, resolved: prefix[0], strategy: "prefix" };
  }
  if (prefix.length > 1) {
    throw ambiguousItemIdError(label, requested, prefix);
  }

  const candidates = suggestItemIds(ids, requested);
  const hint = candidates.length > 0 ? ` Did you mean: ${candidates.join(", ")}?` : "";
  throw new CommandError(
    `${label} "${requested}" was not found in the workspace graph.${hint}`,
    EXIT_CODE.NOT_FOUND,
  );
}

/**
 * Compute a comprehensive offline graph-health report from a shaped graph.
 * All analytics operate on structural edges between item nodes only.
 */
export function analyzeGraph(graph: Graph, topN: number = 10): AnalyzeReport {
  const items = [...itemNodeIds(graph)].sort();
  const edges = structuralEdges(graph);

  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const id of items) {
    inDegree.set(id, 0);
    outDegree.set(id, 0);
  }
  for (const e of edges) {
    outDegree.set(e.from, (outDegree.get(e.from) ?? 0) + 1);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  // Orphans: no structural edges at all (no in, no out).
  const orphans = items.filter((id) => (inDegree.get(id) ?? 0) === 0 && (outDegree.get(id) ?? 0) === 0);
  // Roots: have outgoing/incoming structure but no INCOMING dependency edge.
  const roots = items.filter(
    (id) => (inDegree.get(id) ?? 0) === 0 && (outDegree.get(id) ?? 0) > 0,
  );
  // Leaves: have incoming structure but no outgoing dependency edge.
  const leaves = items.filter(
    (id) => (outDegree.get(id) ?? 0) === 0 && (inDegree.get(id) ?? 0) > 0,
  );

  const cycles = findCycles(items, edges);
  const longest = longestChain(items, edges);

  // Connected components over the UNDIRECTED projection of structural edges.
  const undirected = new Map<string, Set<string>>();
  for (const id of items) undirected.set(id, new Set());
  for (const e of edges) {
    undirected.get(e.from)?.add(e.to);
    undirected.get(e.to)?.add(e.from);
  }
  const visited = new Set<string>();
  let components = 0;
  for (const id of items) {
    if (visited.has(id)) continue;
    components++;
    const queue = [id];
    visited.add(id);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const next of undirected.get(cur) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
  }

  // Blocked items: any item carrying a BLOCKED_BY outgoing edge.
  const blockedItems = items.filter((id) =>
    edges.some((e) => e.from === id && e.type === "BLOCKED_BY"),
  );

  const topDegreeCentrality = items
    .map((id) => ({
      id,
      degree: (inDegree.get(id) ?? 0) + (outDegree.get(id) ?? 0),
      inDegree: inDegree.get(id) ?? 0,
      outDegree: outDegree.get(id) ?? 0,
    }))
    .filter((d) => d.degree > 0)
    .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
    .slice(0, topN);

  // Dependency depth per item: longest directed structural path starting at the
  // item (distance to a leaf). maxDepth is the depth of the critical path.
  const depths = dependencyDepths(items, edges);
  const depthByItem = items
    .map((id) => ({ id, depth: depths.get(id) ?? 0 }))
    .sort((a, b) => b.depth - a.depth || a.id.localeCompare(b.id));
  const maxDepth = depthByItem.reduce((max, d) => (d.depth > max ? d.depth : max), 0);
  const connectors = criticalConnectors(items, edges);

  return {
    workspace: graph.workspace,
    projectKey: graph.projectKey,
    itemCount: items.length,
    structuralEdgeCount: edges.length,
    cycleCount: cycles.length,
    cycles,
    orphanCount: orphans.length,
    orphans,
    rootCount: roots.length,
    roots,
    leafCount: leaves.length,
    leaves,
    longestChainLength: longest.length,
    longestChain: longest,
    connectedComponents: components,
    blockedItemCount: blockedItems.length,
    blockedItems,
    topDegreeCentrality,
    maxDepth,
    depthByItem,
    articulationPointCount: connectors.articulationPoints.length,
    articulationPoints: connectors.articulationPoints,
    bridgeEdgeCount: connectors.bridges.length,
    bridgeEdges: connectors.bridges,
  };
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
  const driver = await createDriver();
  const session = driver.session({ database: process.env.NEO4J_DATABASE });
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
      deletedStaleNodes = toNumber(deleteResult.records[0]?.get("deleted"));
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
    throw neo4jFriendlyError(err);
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
// Help text helpers
// ---------------------------------------------------------------------------

function hasHelpFlag(context: CommandContext): boolean {
  const args = context.args ?? [];
  return args.includes("--help") || args.includes("-h");
}

/**
 * Read the value of a string flag from a raw args array. Handles both the
 * `--flag value` (two-token) and `--flag=value` (single-token) forms. Returns
 * `undefined` when the flag is absent, and `null` when it was given without a
 * value (e.g. a trailing bare `--flag`).
 */
function readFlagStringValue(args: string[], longName: string): string | null | undefined {
  const equalsForm = `${longName}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === longName) {
      // A trailing bare `--flag`, or one followed by another flag (e.g.
      // `--format --json`), has no value — don't swallow the next flag as the
      // value. Return null so the caller falls back to its default.
      const next = args[i + 1];
      return next === undefined || next.startsWith("-") ? null : next;
    }
    if (arg.startsWith(equalsForm)) {
      return arg.slice(equalsForm.length);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Command registrations
// ---------------------------------------------------------------------------

export function activate(api: ExtensionApi): void {
  // The `pm-graph export --format <fmt>` handler renders the graph into a
  // raw offline format (cypher | mermaid | dot | json | graphml | plantuml)
  // and returns it wrapped in a marker object. The host renders command
  // results itself (TOON/JSON), which would re-encode the raw string — so we
  // register an `output_format` service override that unwraps the marker and
  // hands the raw string straight to stdout. `output_format` is a chained
  // service (multiple overrides coexist by design), and this override is a
  // strict no-op for every other command/result.
  api.registerService("output_format", (ctx) => {
    const result = (ctx.payload as { result?: unknown } | undefined)?.result;
    if (
      ctx.command === "pm-graph export" &&
      result !== null &&
      typeof result === "object" &&
      result !== undefined &&
      "__pmGraphRawOutput" in result
    ) {
      const raw = (result as { __pmGraphRawOutput?: unknown }).__pmGraphRawOutput;
      if (typeof raw === "string") return raw;
    }
    return ctx.payload;
  });

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
    description: "Export the current workspace as a dependency and knowledge graph (JSON by default, or another offline format with --format).",
    run: async (context) => {
      const args = context.args ?? [];
      const rawFormat = readFlagStringValue(args, "--format");
      if (hasHelpFlag(context)) {
        return {
          usage: "pm pm-graph export [--format <cypher|mermaid|dot|json|graphml|plantuml>] [--json]",
          description:
            "Export the current workspace as a dependency and knowledge graph. Does not require Neo4j. By default emits the graph object (TOON, or JSON with --json). With --format, renders the graph into the given offline format on stdout (valid JSON for --format json).",
          flags: {
            "--format <fmt>": "Render the graph as cypher | mermaid | dot | json | graphml | plantuml on stdout (default: the graph object)",
            "--json": "Output as JSON",
          },
          output: {
            graph: "Object containing nodes[], relationships[], projectKey, workspace, generatedAt (default, no --format)",
            "--format": "Raw rendered format written to stdout",
          },
        };
      }

      // No --format: preserve the original behaviour (graph object rendered by
      // the host as TOON, or JSON with --json).
      if (rawFormat === undefined) {
        try {
          return {
            ok: true,
            graph: await loadGraph(context),
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new CommandError(`Export failed: ${msg}`, EXIT_CODE.GENERIC_FAILURE);
        }
      }

      if (rawFormat === null || rawFormat.trim().length === 0) {
        throw new CommandError(
          "--format requires a value (cypher | mermaid | dot | json | graphml | plantuml).",
          EXIT_CODE.USAGE,
        );
      }
      const format = rawFormat.trim().toLowerCase() as ExportFormat;
      if (!["cypher", "mermaid", "dot", "json", "graphml", "plantuml"].includes(format)) {
        throw new CommandError(
          `Unknown --format "${rawFormat}". Valid: cypher | mermaid | dot | json | graphml | plantuml.`,
          EXIT_CODE.USAGE,
        );
      }

      try {
        const graph = await loadGraph(context);
        const output = renderExport(format, graph);
        // Wrap the rendered payload in a marker the output_format service override
        // unwraps, so the host writes the raw string to stdout instead of
        // re-encoding it as TOON/JSON.
        return {
          __pmGraphRawOutput: output,
          format,
          nodes: graph.nodes.length,
          relationships: graph.relationships.length,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new CommandError(`Export failed: ${msg}`, EXIT_CODE.GENERIC_FAILURE);
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Cypher generation failed: ${msg}`);
      }
    },
  });

  // --- pm-graph sync -------------------------------------------------------
  api.registerCommand({
    name: "pm-graph sync",
    description:
      "Sync the current workspace graph into Neo4j. Add --full for a complete wipe-and-resync.",
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

      let graph: Graph;
      try {
        graph = await loadGraph(context);
      } catch (err: unknown) {
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
    description:
      "Show Neo4j configuration status, node/relationship counts, last sync timestamp, and extension version.",
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
            version: "2026.7.14",
          },
        };
      }

      const workspace = getWorkspace(context);
      const projectKey = projectKeyForWorkspace(workspace);
      const configured = neo4jConfigured();

      // Always fetch local item count regardless of Neo4j availability
      let localItemCount = 0;
      try {
        const result = await runPmJson<{ items?: PmItem[] }>(context, ["list-all"]);
        localItemCount = result.items?.length ?? 0;
      } catch {
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

      const driver = await createDriver();
      const session = driver.session({ database: process.env.NEO4J_DATABASE });
      try {
        const nodeResult = await session.executeRead((tx) =>
          tx.run(
            "MATCH (n:PmGraphNode {projectKey: $projectKey}) RETURN count(n) AS count",
            { projectKey },
          ),
        );
        const nodeCount = toNumber(nodeResult.records[0]?.get("count"));

        const relResult = await session.executeRead((tx) =>
          tx.run(
            "MATCH (:PmGraphNode {projectKey: $projectKey})-[r]->(:PmGraphNode {projectKey: $projectKey}) RETURN count(r) AS count",
            { projectKey },
          ),
        );
        const relCount = toNumber(relResult.records[0]?.get("count"));

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
          localItemCount,
          nodeCount,
          relationshipCount: relCount,
          lastSyncedAt,
          syncVersion,
          version: EXTENSION_VERSION,
        };
      } catch (err: unknown) {
        throw neo4jFriendlyError(err);
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
    arguments: [
      { name: "cypher-query", required: true, variadic: true, description: "A read-only Cypher query (quote it on the shell)" },
    ],
    examples: [
      'pm pm-graph query "MATCH (n:PmGraphNode {projectKey: \'my-project\'}) RETURN n.id, n.title LIMIT 10" --json',
    ],
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

      // Drop flag tokens (e.g. a trailing `--json`) that the host may leave in
      // args for a variadic positional; otherwise they get joined into the
      // Cypher string and Neo4j rejects `... LIMIT 10 --json` as a syntax error.
      const query = (context.args ?? []).filter((arg) => !arg.startsWith("-")).join(" ").trim();
      if (!query) {
        throw new CommandError(
          'Usage: pm pm-graph query "<cypher-query>"\nExample: pm pm-graph query "MATCH (n:PmGraphNode) RETURN n.id LIMIT 5"',
          EXIT_CODE.USAGE,
        );
      }

      const destructive = findDestructiveKeyword(query);
      if (destructive) {
        throw new CommandError(
          `Blocked destructive Cypher keyword "${destructive}". Only read-only queries (MATCH / RETURN / WITH / ORDER BY / LIMIT / SKIP / WHERE) are allowed.`,
          EXIT_CODE.USAGE,
        );
      }

      if (!neo4jConfigured()) {
        throw new CommandError(neo4jMissingMessage(), EXIT_CODE.GENERIC_FAILURE);
      }

      const driver = await createDriver();
      const session = driver.session({ database: process.env.NEO4J_DATABASE });
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
        throw neo4jFriendlyError(err);
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
    arguments: [
      { name: "node-id", required: true, description: "The PmGraphNode id to inspect (e.g. TASK-42)" },
    ],
    examples: ["pm pm-graph neighbors TASK-42 --json"],
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

      // Skip flag tokens (e.g. a trailing `--json`) the host may leave in args
      // so the node id is never a flag.
      const nodeId = (context.args ?? []).find((arg) => !arg.startsWith("-"));
      if (!nodeId) {
        throw new CommandError(
          "Usage: pm pm-graph neighbors <node-id>\nExample: pm pm-graph neighbors TASK-42",
          EXIT_CODE.USAGE,
        );
      }

      if (!neo4jConfigured()) {
        throw new CommandError(neo4jMissingMessage(), EXIT_CODE.GENERIC_FAILURE);
      }

      const projectKey = projectKeyForWorkspace(getWorkspace(context));
      const driver = await createDriver();
      const session = driver.session({ database: process.env.NEO4J_DATABASE });
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
        throw neo4jFriendlyError(err);
      } finally {
        await session.close();
        await driver.close();
      }
    },
  });

  // --- pm-graph analyze ----------------------------------------------------
  api.registerCommand({
    name: "pm-graph analyze",
    description:
      "Comprehensive offline graph-health report: cycles, orphans, roots, leaves, longest chain, bottleneck connectors, degree centrality, components, blocked items.",
    run: async (context) => {
      if (hasHelpFlag(context)) {
        return {
          usage: "pm pm-graph analyze [--root <id>] [--depth <n>] [--filter type=...|status=...] [--include-closed] [--json]",
          description:
            "Build the workspace dependency graph offline (no Neo4j) and report its health: dependency cycle count, orphan/root/leaf items, longest dependency chain, top degree-centrality items, connected-component count, and blocked-item count. Operates on STRUCTURAL edges (BLOCKED_BY + CHILD_OF + dependency edges) only.",
          flags: {
            "--root <id>": "Restrict to the neighborhood of an item id",
            "--depth <n>": "Max hop distance from --root (non-negative integer)",
            "--filter type=...|status=...": "Keep only PmItem nodes matching the given type/status (comma-list or repeat of same key = OR; different keys = AND)",
            "--include-closed": "Include closed/canceled items (excluded by default)",
            "--json": "Output as JSON",
          },
          output: {
            itemCount: "Number of item nodes analyzed",
            structuralEdgeCount: "Number of structural edges analyzed",
            cycleCount: "Number of distinct dependency cycles",
            orphans: "Item ids with no structural edges",
            roots: "Item ids with no incoming dependency edge",
            leaves: "Item ids with no outgoing dependency edge",
            longestChain: "Ordered ids of the longest dependency chain",
            connectedComponents: "Number of connected components (undirected projection)",
            blockedItems: "Item ids carrying a BLOCKED_BY edge",
            topDegreeCentrality: "Top-N items by total degree",
            maxDepth: "Longest dependency depth across all items (critical-path depth)",
            depthByItem: "Per-item dependency depth (longest path from the item to a leaf), sorted deepest-first",
            articulationPoints: "Items whose removal disconnects part of the structural graph",
            bridgeEdges: "Structural item-to-item links whose removal disconnects part of the structural graph",
          },
        };
      }
      const flags = parseAnalyticsFlags(context.args ?? []);
      const graph = shapedAnalyticsGraph(context, flags);
      const report = analyzeGraph(graph);
      return { ok: true, ...report };
    },
  });

  // --- pm-graph cycles -----------------------------------------------------
  api.registerCommand({
    name: "pm-graph cycles",
    description:
      "Detect and list dependency cycles among structural edges. Exits non-zero (1) when cycles exist — CI-usable.",
    run: async (context) => {
      if (hasHelpFlag(context)) {
        return {
          usage: "pm pm-graph cycles [--root <id>] [--depth <n>] [--filter type=...|status=...] [--include-closed] [--json] [--format <text|mermaid|graphml|dot>]",
          description:
            "Detect dependency cycles among STRUCTURAL edges (BLOCKED_BY + dependency edges, not facet/tag edges). Prints each cycle as an id path. Exits with code 1 when any cycle exists (so it can gate CI); exits 0 when there are none. With --format mermaid|graphml|dot, prints the cycle-participating subgraph (union of cycle nodes + their edges) as a diagram before exiting 1, for embedding in docs.",
          flags: {
            "--root <id>": "Restrict to the neighborhood of an item id",
            "--depth <n>": "Max hop distance from --root",
            "--filter type=...|status=...": "Keep only PmItem nodes matching the given type/status (comma-list or repeat of same key = OR; different keys = AND)",
            "--include-closed": "Include closed/canceled items",
            "--json": "Output as JSON",
            "--format <text|mermaid|graphml|dot>": "Output the cycle subgraph as a diagram (default text)",
          },
          output: {
            cycleCount: "Number of distinct cycles",
            cycles: "Array of cycles, each an ordered id path (first === last)",
          },
        };
      }
      const flags = parseAnalyticsFlags(context.args ?? []);
      const graph = shapedAnalyticsGraph(context, flags);
      const edges = structuralEdges(graph);
      const items = [...itemNodeIds(graph)].sort();
      const cycles = findCycles(items, edges);
      if (cycles.length > 0) {
        if (flags.format !== "text") {
          // Emit the diagram first so users get the visualization, then exit 1
          // to preserve the CI-gating contract.
          console.log(renderAnalysisDiagram(flags.format, cyclesSubgraph(graph, cycles)));
        }
        const detail = cycles.map((c) => c.join(" -> ")).join("; ");
        throw new CommandError(
          `Found ${cycles.length} dependency cycle(s): ${detail}`,
          EXIT_CODE.GENERIC_FAILURE,
        );
      }
      // No cycles: an empty diagram is meaningless, so the format flag is a
      // no-op here and the text/JSON result is returned unchanged.
      return { ok: true, cycleCount: 0, cycles: [] };
    },
  });

  // --- pm-graph path -------------------------------------------------------
  api.registerCommand({
    name: "pm-graph path",
    description:
      "Shortest directed dependency path between two item ids (BFS over structural edges).",
    run: async (context) => {
      if (hasHelpFlag(context)) {
        return {
          usage: "pm pm-graph path <from> <to> [--filter type=...|status=...] [--include-closed] [--json]",
          description:
            "Compute the shortest directed dependency path from <from> to <to> via BFS over STRUCTURAL edges. Item ids resolve by exact match, case-insensitive match, then unique prefix.",
          flags: {
            "--filter type=...|status=...": "Keep only PmItem nodes matching the given type/status (comma-list or repeat of same key = OR; different keys = AND)",
            "--include-closed": "Include closed/canceled items",
            "--json": "Output as JSON",
          },
          example: "pm pm-graph path pm-ep18 pm-hd71 --json",
          output: {
            from: "Source item id",
            to: "Target item id",
            found: "Whether a directed path exists",
            path: "Ordered id path (inclusive) or null",
            length: "Number of edges on the path (path.length - 1) or null",
          },
        };
      }
      const flags = parseAnalyticsFlags(context.args ?? []);
      const [from, to] = flags.positionals;
      if (!from || !to) {
        throw new CommandError(
          "Usage: pm pm-graph path <from> <to>\nExample: pm pm-graph path pm-ep18 pm-hd71",
          EXIT_CODE.USAGE,
        );
      }
      const graph = shapedAnalyticsGraph(context, flags);
      const itemIds = [...itemNodeIds(graph)].sort();
      const resolvedFrom = resolveItemIdOrThrow(itemIds, from, "Source item").resolved;
      const resolvedTo = resolveItemIdOrThrow(itemIds, to, "Target item").resolved;
      const edges = structuralEdges(graph);
      const path = shortestPath(edges, resolvedFrom, resolvedTo);
      return {
        ok: true,
        from: resolvedFrom,
        to: resolvedTo,
        found: path !== null,
        path,
        length: path ? path.length - 1 : null,
      };
    },
  });

  // --- pm-graph critical-path ---------------------------------------------
  api.registerCommand({
    name: "pm-graph critical-path",
    description:
      "The longest chain of blocking dependencies through the workspace (the critical path), as an ordered id list.",
    run: async (context) => {
      if (hasHelpFlag(context)) {
        return {
          usage: "pm pm-graph critical-path [--root <id>] [--depth <n>] [--filter type=...|status=...] [--include-closed] [--json] [--format <text|mermaid|graphml|dot>]",
          description:
            "Compute the longest chain of structural (blocking) dependencies through the workspace — the critical path. Reports the ordered id list and its length. Cycle-safe. With --format mermaid|graphml|dot, prints the critical-path chain as a diagram subgraph (chain nodes + connecting edges) for embedding in docs.",
          flags: {
            "--root <id>": "Restrict to the neighborhood of an item id",
            "--depth <n>": "Max hop distance from --root",
            "--filter type=...|status=...": "Keep only PmItem nodes matching the given type/status (comma-list or repeat of same key = OR; different keys = AND)",
            "--include-closed": "Include closed/canceled items",
            "--json": "Output as JSON",
            "--format <text|mermaid|graphml|dot>": "Output the critical-path subgraph as a diagram (default text)",
          },
          output: {
            length: "Number of items on the critical path",
            path: "Ordered id list of the critical path",
          },
        };
      }
      const flags = parseAnalyticsFlags(context.args ?? []);
      const graph = shapedAnalyticsGraph(context, flags);
      const edges = structuralEdges(graph);
      const items = [...itemNodeIds(graph)].sort();
      const chain = longestChain(items, edges);
      if (flags.format !== "text") {
        const diagram = renderAnalysisDiagram(flags.format, criticalPathSubgraph(graph, chain));
        console.log(diagram);
        return { ok: true, format: flags.format, length: chain.length, path: chain, diagram };
      }
      return { ok: true, length: chain.length, path: chain };
    },
  });

  // --- pm-graph topo-sort --------------------------------------------------
  api.registerCommand({
    name: "pm-graph topo-sort",
    description:
      "Topological execution order respecting dependency/blocked_by edges (Kahn's algorithm). Exits non-zero (1) on a cycle.",
    run: async (context) => {
      if (hasHelpFlag(context)) {
        return {
          usage: "pm pm-graph topo-sort [--root <id>] [--depth <n>] [--filter type=...|status=...] [--include-closed] [--json]",
          description:
            "Emit a valid topological execution order of items over STRUCTURAL edges (BLOCKED_BY + dependency edges), so each item is listed only after the items it depends on. Uses Kahn's algorithm. Ties are broken by ascending id for deterministic output. Reports the resolvable prefix and the cycle members, and EXITS WITH CODE 1 when a dependency cycle prevents a complete ordering (CI-usable).",
          flags: {
            "--root <id>": "Restrict to the neighborhood of an item id",
            "--depth <n>": "Max hop distance from --root",
            "--filter type=...|status=...": "Keep only PmItem nodes matching the given type/status (comma-list or repeat of same key = OR; different keys = AND)",
            "--include-closed": "Include closed/canceled items",
            "--json": "Output as JSON",
          },
          output: {
            order: "Ordered item ids (dependencies before dependents); complete when acyclic",
            count: "Number of items placed in the order",
            cyclic: "Whether a cycle prevented a complete ordering",
          },
        };
      }
      const flags = parseAnalyticsFlags(context.args ?? []);
      const graph = shapedAnalyticsGraph(context, flags);
      const edges = structuralEdges(graph);
      const items = [...itemNodeIds(graph)].sort();
      const { order, cycleNodes } = topoSort(items, edges);
      if (cycleNodes.length > 0) {
        // Surface the actual cycle path(s) among the unresolved nodes for context.
        const cycles = findCycles(cycleNodes, edges);
        const detail = cycles.length > 0
          ? cycles.map((c) => c.join(" -> ")).join("; ")
          : cycleNodes.join(", ");
        throw new CommandError(
          `Cannot produce a topological order: ${cycleNodes.length} item(s) are involved in a dependency cycle (${detail}). Resolved prefix: ${order.length} item(s).`,
          EXIT_CODE.GENERIC_FAILURE,
        );
      }
      return { ok: true, count: order.length, cyclic: false, order };
    },
  });

  // --- pm-graph impact -----------------------------------------------------
  api.registerCommand({
    name: "pm-graph impact",
    description:
      "List all items transitively blocked-by / downstream of an item id (reverse-reachable set) with a count.",
    run: async (context) => {
      if (hasHelpFlag(context)) {
        return {
          usage: "pm pm-graph impact <id> [--filter type=...|status=...] [--include-closed] [--json]",
          description:
            "Compute the impact set of an item: every item that transitively depends on it (is blocked-by / downstream of it) over STRUCTURAL edges. Item ids resolve by exact match, case-insensitive match, then unique prefix.",
          flags: {
            "--filter type=...|status=...": "Keep only PmItem nodes matching the given type/status (comma-list or repeat of same key = OR; different keys = AND)",
            "--include-closed": "Include closed/canceled items",
            "--json": "Output as JSON",
          },
          example: "pm pm-graph impact pm-ep18 --json",
          output: {
            id: "The item whose downstream impact was computed",
            count: "Number of items transitively affected",
            impacted: "Sorted ids of all items transitively blocked-by/downstream of <id>",
          },
        };
      }
      const flags = parseAnalyticsFlags(context.args ?? []);
      const [id] = flags.positionals;
      if (!id) {
        throw new CommandError(
          "Usage: pm pm-graph impact <id>\nExample: pm pm-graph impact pm-ep18",
          EXIT_CODE.USAGE,
        );
      }
      const graph = shapedAnalyticsGraph(context, flags);
      const itemIds = [...itemNodeIds(graph)].sort();
      const resolvedId = resolveItemIdOrThrow(itemIds, id, "Item").resolved;
      const edges = structuralEdges(graph);
      const impacted = reverseReachable(edges, resolvedId);
      return { ok: true, id: resolvedId, count: impacted.length, impacted };
    },
  });

  // --- pm-graph explain ----------------------------------------------------
  api.registerCommand({
    name: "pm-graph explain",
    description:
      "Explain a single item offline: blockers, dependents, transitive impact, depth, and cycle participation.",
    run: async (context) => {
      if (hasHelpFlag(context)) {
        return {
          usage: "pm pm-graph explain <id> [--filter type=...|status=...] [--include-closed] [--json]",
          description:
            "Build an offline item-centric dependency report for one id over STRUCTURAL edges. Item ids resolve by exact match, case-insensitive match, then unique prefix.",
          flags: {
            "--filter type=...|status=...": "Keep only PmItem nodes matching the given type/status (comma-list or repeat of same key = OR; different keys = AND)",
            "--include-closed": "Include closed/canceled items",
            "--json": "Output as JSON",
          },
          output: {
            item: "Core item fields (id/title/type/status/priority/assignee/sprint/release/deadline)",
            blockers: "Immediate blockers/dependencies with relation types",
            dependents: "Immediate downstream dependents with relation types",
            transitiveDependents: "All transitively downstream items",
            dependencyDepth: "Longest directed blocker distance from the item to a leaf",
            criticalChainFromItem: "Longest dependency chain starting at the item",
            cycleCount: "Number of dependency cycles containing this item",
          },
        };
      }
      const flags = parseAnalyticsFlags(context.args ?? []);
      const [id] = flags.positionals;
      if (!id) {
        throw new CommandError(
          "Usage: pm pm-graph explain <id>\nExample: pm pm-graph explain pm-ep18",
          EXIT_CODE.USAGE,
        );
      }
      const graph = shapeGraph(loadGraphForContext(context), {
        edges: "deps",
        includeClosed: flags.includeClosed,
        filter: flags.filter,
      });
      const resolvedId = resolveItemIdOrThrow([...itemNodeIds(graph)].sort(), id, "Item").resolved;
      const report = explainItem(graph, resolvedId);
      if (!report) {
        throw new CommandError(
          `Item "${resolvedId}" was not found in the workspace graph.`,
          EXIT_CODE.NOT_FOUND,
        );
      }
      return { ok: true, ...report };
    },
  });

  // --- pm graph export -----------------------------------------------------
  // registerExporter("graph") auto-creates the `pm graph export` command (the
  // `<name> export` form). It does NOT collide with the existing
  // `pm pm-graph cypher` command (different name). The export pipeline builds
  // the workspace graph from a single `pm list-all --json --include-body`
  // call and renders it to one of six offline formats (cypher | mermaid | dot |
  // json | graphml | plantuml). No Neo4j required.
  const exporter: Exporter = (ctx: ImportExportContext) => {
    const options = ctx.options ?? {};

    const rawFormat = String(readExportOption(options, "format") ?? "json").toLowerCase();
    if (!["cypher", "mermaid", "dot", "json", "graphml", "plantuml"].includes(rawFormat)) {
      throw new CommandError(
        `Unknown --format "${rawFormat}". Valid: cypher | mermaid | dot | json | graphml | plantuml.`,
        EXIT_CODE.USAGE,
      );
    }
    const format = rawFormat as ExportFormat;

    const rawEdges = String(readExportOption(options, "edges") ?? "all").toLowerCase();
    if (!["deps", "tags", "all"].includes(rawEdges)) {
      throw new CommandError(
        `Unknown --edges "${rawEdges}". Valid: deps | tags | all.`,
        EXIT_CODE.USAGE,
      );
    }
    const edges = rawEdges as EdgeFilter;

    const includeClosed = Boolean(readExportOption(options, "include-closed", "includeClosed"));

    const rootId = readExportOption(options, "root");
    const root = typeof rootId === "string" && rootId.trim().length > 0 ? rootId.trim() : undefined;

    const rawDepth = readExportOption(options, "depth");
    let depth: number | undefined;
    if (rawDepth !== undefined) {
      const parsed = parseInt(String(rawDepth), 10);
      if (Number.isNaN(parsed) || parsed < 0) {
        throw new CommandError(`Invalid --depth "${rawDepth}" (expected a non-negative integer).`, EXIT_CODE.USAGE);
      }
      depth = parsed;
    }

    const fullGraph = loadGraphFromPath(ctx.pm_root);

    if (root && !fullGraph.nodes.some((n) => n.id === root)) {
      throw new CommandError(`--root node "${root}" was not found in the workspace graph.`, EXIT_CODE.NOT_FOUND);
    }

    const rawFilter = readExportOption(options, "filter");
    const filterTerms = Array.isArray(rawFilter)
      ? (rawFilter as unknown[]).map((v) => String(v))
      : rawFilter !== undefined && rawFilter !== null && rawFilter !== ""
        ? [String(rawFilter)]
        : [];
    const filter = parseNodeFilter(filterTerms);

    const graph = shapeGraph(fullGraph, { edges, includeClosed, rootId: root, depth, filter });
    const output = renderExport(format, graph);

    const outputPath = readExportOption(options, "output") as string | undefined;
    if (outputPath) {
      const absolutePath = path.resolve(outputPath);
      writeFileSync(absolutePath, output + "\n", "utf-8");
      console.error(
        `graph export: wrote ${graph.nodes.length} node(s), ${graph.relationships.length} edge(s) as ${format} to ${absolutePath}`,
      );
      return {
        ok: true,
        format,
        edges,
        nodes: graph.nodes.length,
        relationships: graph.relationships.length,
        file: absolutePath,
      };
    }

    console.log(output);
    return {
      ok: true,
      format,
      edges,
      filter: filter.length > 0 ? filter : undefined,
      nodes: graph.nodes.length,
      relationships: graph.relationships.length,
      output,
    };
  };

  api.registerExporter("graph", exporter);
}

export default { activate };
