# pm-graph

Knowledge graph and dependency graph extension for pm CLI workspaces.

The extension is scaffolded with the latest `pm extension init` flow, then implemented in TypeScript. It reads the current workspace through the real `pm list-all --json` command and turns items, parent links, and dependency metadata into graph nodes and relationships.

## Install

```bash
pm extension install github.com/unbraind/pm-graph --project
pm pm-graph ping
pm extension --doctor --project --detail summary
```

## Commands

```bash
pm pm-graph ping
pm pm-graph export --json
pm pm-graph cypher --json
pm pm-graph sync --json
```

`pm-graph export` returns JSON with `nodes` and `relationships`. `pm-graph cypher` returns parameterized Cypher statements. `pm-graph sync` writes directly to Neo4j.

## Neo4j

Set these environment variables before running `pm pm-graph sync`:

```bash
export NEO4J_URI=bolt://localhost:7687
export NEO4J_USER=neo4j
export NEO4J_PASSWORD=change-me
export NEO4J_DATABASE=neo4j
```

## Development

```bash
npm install
npm run build
pm extension install --project .
pm pm-graph export --json
```
