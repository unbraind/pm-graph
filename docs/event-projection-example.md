# Event-sparse projection receipts

Admit an explicit tracker once, then refresh its checkpoint after SDK mutations:

```sh
pm --pm-path tracker/.agents/pm pm-graph refresh projection.json --json
pm --pm-path tracker/.agents/pm update task-id --title "Revised title"
pm --pm-path tracker/.agents/pm pm-graph refresh projection.json --limit 20 --json
pm pm-graph refresh projection.json --receipt --offset 20 --limit 20 --json
```

JSON and the default TOON output contain the mode, revision, opaque cursor,
source read counts, SDK event-page sources, evaluated node/edge counts, and bounded
exact `work` rows. A node/edge appears when its old or new owning item contribution
was evaluated, including removed and unchanged entities. Shared facets and external
endpoints appear once. `--receipt` pages the last committed work independently of
source refresh; a no-op refresh preserves that stored receipt and its revision.

`fullScans` counts certified item-corpus reads by this package. `itemReads` counts
SDK point reads (or admitted items). `eventSources` discloses whether the SDK used
`derived_index` or `authoritative_history`; the latter can scan histories internally.
Checkpoint parsing, cached graph materialization/diffing, and serialization still
visit cached rows. This is sparse source projection, not constant-time checkpoint IO.

A `CURSOR_GAP` refuses to advance the checkpoint. It covers changed/lost cursor
anchors, noncontiguous subject versions, and workspace-schema mutations. Run
`--rebuild` explicitly to replace the derived projection after a new certified full
read. Rebuild resets cursor, anchor and per-subject versions together, including
when authoritative history is empty. The target revision lineage remains intact
for sink CAS; the checkpoint format and existing v1 read contract are unchanged.
Opaque cursor interpretation, source completeness, and mutation ordering
remain SDK responsibilities; direct source-file edits outside SDK mutation/history
contracts require an explicit rebuild. Each refresh is bounded to 100000 items,
1000000 events, a 128 MiB checkpoint, JSON depth 24, and strings of 65536 characters.
Source churn refuses with `SOURCE_BUSY`; retry. Invalid/foreign checkpoints refuse
with `FOREIGN_STATE` even with `--rebuild`; choose another file. Existing JSON
`null`, other scalar values, arrays and malformed files remain foreign storage,
never an absent checkpoint. Only a missing file admits a new projection. Source failures
leave the previous committed checkpoint available. Refusals carry `exit_code: 2`
and a machine-readable code/remedy without echoing source errors or paths.

```ts
import { refreshEventProjection, readEventProjection } from 'pm-graph';

const receipt = await refreshEventProjection({
  pmRoot: 'tracker/.agents/pm', stateFile: 'projection.json', limit: 20,
});
if (receipt.ok) {
  const state = await readEventProjection('projection.json');
  // state.graph is the complete offline Graph, including facets and external nodes.
  // Receipts are compact; graph export is an explicit separate read.
}
```

The canonical graph uses item-id owner ordering for stable first-owner facet
properties; graph array ordering and generation timestamps are not semantic changes.
All native node properties and relationships use the existing graph producer.
No status is interpreted by its spelling; custom active/terminal statuses are
projected verbatim and every configured status is admitted.

For Neo4j, use a **separate checkpoint from the first admission**:

```sh
pm --pm-path tracker/.agents/pm pm-graph refresh neo4j-projection.json --neo4j --json
```

This uses the existing Neo4j connection settings and unique marker and node constraints.
One transaction locks and checks the current target, applies changed graph entities
and removals, and commits both the projection revision and its native SDK history
coordinates. `PmGraphProjectionNode` and `PmGraphProjection` are owned namespaces
isolated from legacy `sync` records; foreign graph records are preserved. Conflicting
ownership or source history unknown to the SDK yields typed `SINK_CONFLICT`.

Before a sink action, the package writes `neo4j-projection.json.pending.json` using
the same strict checkpoint schema. Keep this owned recovery record with the
checkpoint. It is not evidence that the sink committed: recovery first reads the
sink marker. If the marker matches a valid intent whose native history entry still
exists, recovery publishes that committed checkpoint and catches up from its SDK
cursor, even if several source updates happened after the crash. This also works
when the first admission committed remotely but never produced a local checkpoint.
An interrupted checkpoint or receipt publication can be retried repeatedly.
The receipt is embedded in the same atomic checkpoint, so no separate receipt file
can advance independently. `--receipt` reads only a published checkpoint.

A source-known marker without cached recovery contributions requires a disclosed
certified recovery rebuild. A source-unknown marker refuses ordinary refresh.
Explicit `--rebuild --neo4j` reads the current marker and reprojects the current
certified source with a transaction-protected CAS. It resets owned relationships,
upserts all current nodes and removes stale owned nodes. Foreign relationships on
retained nodes survive; a foreign edge that prevents deleting a stale node still
refuses the transaction. A stale checkpoint alone cannot block rebuild. Foreign
checkpoint/recovery files remain untouched, including JSON `null`.

SDK callers use the same built-in sink as the CLI:

```ts
import { createNeo4jProjectionSink, refreshEventProjection } from 'pm-graph';

await refreshEventProjection({
  pmRoot: 'tracker/.agents/pm', stateFile: 'neo4j-projection.json',
  sink: createNeo4jProjectionSink(),
});
```

The factory is lazy and uses the existing Neo4j connection settings. Custom sinks
expose a stable target-bound `key`, `inspect(projectKey)` returning the owned
`revision` and `sourceHead`, and an atomic `apply(delta)` that re-reads and compares
the current revision before writes. `delta.rebuild` requests complete owned-target
reconciliation, and `delta.sourceHead` must commit with its revision in the same
transaction. The old apply-only CAS surface remains supported: pending actions are
reconciled through its required idempotent, revision-checked apply before planning
new work. Repair of an arbitrary unknown target needs marker inspection.

Reconciliation holds the checkpoint's SDK lease through intent, sink, checkpoint
and receipt publication. A recovered commit is retained even when a later source
guard refuses new work; source history and all successful audit records remain
unchanged. Cached intent/checkpoint serialization is additional full-cache IO,
not a complete source-item scan or a complete Neo4j input upsert.

Run the public-data validator with an explicit non-git public tracker copy and
separate writable checkpoint:

```sh
node scripts/validate-event-projection.ts public-tracker/.agents/pm receipts/public.json
```

It compares the stored graph to a fresh certified full projection, measures
catch-up reads/output bytes, and hashes authoritative source files before and after.
