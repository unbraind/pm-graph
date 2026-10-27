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
read. Opaque cursor interpretation, source completeness, and mutation ordering
remain SDK responsibilities; direct source-file edits outside SDK mutation/history
contracts require an explicit rebuild. Each refresh is bounded to 100000 items,
1000000 events, a 128 MiB checkpoint, JSON depth 24, and strings of 65536 characters.
Source churn refuses with `SOURCE_BUSY`; retry. Invalid/foreign checkpoints refuse
with `FOREIGN_STATE` even with `--rebuild`; choose another file. Source failures
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
One transaction locks and checks the target revision, applies only changed graph
entities and removals, then advances the marker. `PmGraphProjectionNode` and
`PmGraphProjection` are owned namespaces isolated from legacy `sync` records;
foreign graph records are untouched. A collision with a foreign marker, touched node
or incident edge refuses the dependent delta with `SINK_CONFLICT`. Reusing a checkpoint with another target
refuses. Custom SDK sinks must expose a stable `key` bound to their actual target
and implement `ProjectionSink.apply` as an atomic revision compare-and-set.
A successful sink write followed by checkpoint failure can be retried safely: the
source and target revisions are read again; an already-applied target revision
reports success. A competing newer target yields `SINK_CONFLICT`.

Run the public-data validator with an explicit non-git public tracker copy and
separate writable checkpoint:

```sh
node scripts/validate-event-projection.ts public-tracker/.agents/pm receipts/public.json
```

It compares the stored graph to a fresh certified full projection, measures
catch-up reads/output bytes, and hashes authoritative source files before and after.
