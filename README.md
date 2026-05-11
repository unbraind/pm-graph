# pm-graph

Knowledge graph and dependency graph extension for pm CLI workspaces.

The extension is scaffolded with the latest `pm extension init` flow, then implemented in TypeScript. It reads the current workspace through real `pm list-all --json` and `pm deps <id> --json` commands, then turns items, parent links, dependency metadata, tags, statuses, types, assignees, sprints, and releases into graph nodes and relationships.

## Install

```bash
pm extension install github.com/unbraind/pm-graph --project
pm pm-graph ping
pm extension doctor --project --detail summary
```

## Commands

```bash
pm pm-graph ping
pm pm-graph export --json
pm pm-graph cypher --json
pm pm-graph sync --json
```

`pm-graph export` returns JSON with `nodes`, `relationships`, and a project key. `pm-graph cypher` returns parameterized Cypher statements using the `PmGraphNode` label. `pm-graph sync` writes directly to Neo4j, replacing stale `PmGraphNode` rows only for the current project key before writing fresh graph data.

The graph model includes:

- `PmItem` nodes for real pm items.
- `ExternalPmItem` nodes for dependency targets that are referenced but not present in the current workspace export.
- `PmFacet` nodes for metadata such as type, status, assignee, sprint, release, and tags.
- Relationships such as `CHILD_OF`, dependency relationship types from `pm deps`, `HAS_TYPE`, `HAS_STATUS`, `ASSIGNED_TO`, `IN_SPRINT`, `IN_RELEASE`, and `TAGGED_WITH`.

## Neo4j

Set these environment variables before running `pm pm-graph sync`:

```bash
export NEO4J_URI=bolt://localhost:7687
export NEO4J_USER=neo4j
export NEO4J_PASSWORD=change-me
export NEO4J_DATABASE=neo4j
export PM_GRAPH_PROJECT_KEY=my-project
```

`PM_GRAPH_PROJECT_KEY` is optional. When it is not set, the extension uses the current workspace path as the project key so separate pm workspaces do not overwrite each other in Neo4j.

## Development

```bash
npm install
npm run build
pm extension install --project .
pm pm-graph export --json
```
