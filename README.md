# pm-graph

Knowledge graph and dependency graph extension for pm CLI workspaces.

The extension reads the current workspace through `pm list-all --json` and `pm deps <id> --json` commands, then turns items, parent links, `blocked_by` metadata, dependency metadata, tags, statuses, types, assignees, sprints, and releases into graph nodes and relationships.

## Install

```bash
pm extension install github.com/unbraind/pm-graph --project
pm pm-graph ping
pm extension doctor --project --detail summary
```

## Commands

### `pm pm-graph ping`

Verify that the pm-graph extension is active. Returns extension version and whether Neo4j is configured.

```bash
pm pm-graph ping --json
```

### `pm pm-graph export`

Export the current workspace as a dependency and knowledge graph in JSON format. Returns `nodes`, `relationships`, and a `projectKey`. Does **not** require Neo4j.

```bash
pm pm-graph export --json
```

### `pm pm-graph cypher`

Render parameterized Cypher statements for importing the current workspace graph into Neo4j. Returns the statements without executing them.

```bash
pm pm-graph cypher --json
```

### `pm pm-graph sync`

Sync the current workspace graph into Neo4j using `NEO4J_*` environment variables.

- **Default (incremental):** Upserts all nodes and relationships, then deletes stale nodes that are no longer present in the workspace. Existing nodes are preserved and updated.
- **`--full`:** Performs a complete wipe-and-resync — deletes all `PmGraphNode` entries for the project before re-importing.

After every sync, a `_lastSyncedAt` timestamp is stored in Neo4j on a `PmGraphSync` metadata node.

```bash
pm pm-graph sync --json          # incremental
pm pm-graph sync --full --json   # complete resync
```

Returns: `syncedNodes`, `syncedRelationships`, `deletedStaleNodes`, and whether `fullSync` was used.

### `pm pm-graph status`

Show Neo4j configuration status, node and relationship counts for the current project, the last sync timestamp, and the extension version.

```bash
pm pm-graph status --json
```

Returns:

- `neo4jConfigured` — whether the required env vars are set
- `projectKey` — the derived project key
- `nodeCount` — number of `PmGraphNode` entries in Neo4j
- `relationshipCount` — number of relationships between `PmGraphNode` entries
- `lastSyncedAt` — timestamp of the most recent sync (or `null`)
- `version` — extension version

### `pm pm-graph query`

Run a **read-only** Cypher query against Neo4j and return JSON results. Destructive Cypher keywords (`CREATE`, `MERGE`, `DELETE`, `DETACH`, `DROP`, `REMOVE`, `SET`) are blocked to prevent accidental data modification.

```bash
pm pm-graph query "MATCH (n:PmGraphNode {projectKey: 'my-project'}) RETURN n.id, n.title LIMIT 10" --json
```

Returns: `count` and `records` arrays with all values converted to plain JSON.

### `pm pm-graph neighbors`

Return all 1-hop neighbors with relationships for a given node ID. Each neighbor includes the relationship type, direction (`outgoing` or `incoming`), and properties.

```bash
pm pm-graph neighbors TASK-42 --json
```

Returns: `center` (the queried node) and `neighbors` (array of connected nodes with their relationships).

## Graph Model

- **`PmItem`** nodes for real pm items.
- **`ExternalPmItem`** nodes for dependency targets that are referenced but not present in the current workspace export.
- **`PmFacet`** nodes for metadata such as type, status, assignee, sprint, release, and tags.
- **`PmGraphSync`** metadata node storing the last sync timestamp and extension version per project.
- Relationships: `CHILD_OF`, `BLOCKED_BY`, dependency relationship types from `pm deps`, `HAS_TYPE`, `HAS_STATUS`, `ASSIGNED_TO`, `IN_SPRINT`, `IN_RELEASE`, `TAGGED_WITH`.

## Neo4j Configuration

Set these environment variables before running commands that require Neo4j (`sync`, `status`, `query`, `neighbors`):

```bash
export NEO4J_URI=bolt://localhost:7687
export NEO4J_USER=neo4j
export NEO4J_PASSWORD=change-me
export NEO4J_DATABASE=neo4j          # optional, defaults to the server default
export PM_GRAPH_PROJECT_KEY=my-project  # optional
```

### Project Key

`PM_GRAPH_PROJECT_KEY` is optional. When not set, the extension derives the project key from the workspace directory name using `path.basename()`. This ensures separate pm workspaces get distinct keys and do not overwrite each other in Neo4j.

## Error Handling

All Neo4j operations include proper error handling:

- Missing environment variables produce clear, actionable messages listing exactly which variables are unset.
- Connection and query failures are caught and wrapped with descriptive error messages.
- The `query` command blocks destructive Cypher keywords to protect data integrity.
- Driver sessions are always closed in `finally` blocks to prevent connection leaks.

## Development

```bash
npm install
npm run build
pm extension install --project .
pm pm-graph export --json
```
