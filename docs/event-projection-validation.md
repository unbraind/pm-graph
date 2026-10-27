# Event-sparse projection validation

Public corpus: `unbraind/pm-graph` main at `42e20bb`, copied from tracked files
into a non-git scratch directory. Authoritative source files and directories were
made read-only after warming the SDK event index; writable projection storage was
separate. No source mutations were attempted by the feature. The refreshed measurement includes
all schema files in the source fingerprint.

| Measurement | Result |
| --- | ---: |
| Certified items | 109 |
| Projected nodes / edges | 205 / 376 |
| Admission mutation events | 1160 |
| Admission complete item scans | 1 |
| Caught-up complete item scans / item reads / events | 0 / 0 / 0 |
| Caught-up JSON receipt | 559 bytes |
| SDK event source | derived_index |
| Graph equals fresh certified full projection | yes |
| Authoritative filenames and bytes unchanged | yes |
| Admission, catch-up and source verification on a shared host | 17775 ms |

The synthetic scale regression uses 10000 SDK-readable native documents in a real
non-git tracker and performs the single update through the SDK. It measured 1 item
read, 0 complete item scans, 3 evaluated nodes, 2 evaluated edges and an 814-byte
JSON receipt. Both the certified full graph and explicit rebuilt projection equal
the incremental graph. Checkpoint decoding, cached materialization and verification
are additional work and are not claimed to be constant time.

The seeded model uses seed `0x261027` and 500 random operation sequences, with
older-input replays, CRLF/whitespace variants, relationships, all projected native
fields, and custom statuses. The source reference model is updated only from SDK
reads, and the stored producer output must validate and equal the full graph's
JSON wire representation. An independent sink delta model checks synchronization.
A separate regression covers legacy optional dependency metadata absent from
newly created SDK records; the public corpus exposed that case.

The storage interleaving test injects a competing refresher at all 27 applicable
offline and sink transition boundaries on the same tracker. The sink recovery test interrupts after
sink commit, verifies checkpoint retention, retries the same target revision, and
refuses a competing newer target. Driver-adapter tests cover the Neo4j transaction
queries and lifecycle using the repository's driver fixture with real SDK sources;
this does not attest a live Neo4j deployment.

Reproduce with `node scripts/validate-event-projection.ts <public-copy-tracker>
<separate-checkpoint>` and `node --test --test-concurrency=2
test/event-projection.test.ts test/event-projection-neo4j.test.ts`. Packed acceptance
is `node test/event-projection-packed.validation.ts` and uses actual npm/Bun global,
npx/bunx and project-local hosts without resolving the SDK from executable paths.

## Re-review recovery regressions

Two general invariants now have adversarial coverage: storage presence is
independent of its decoded JSON value, and rebuilds start a coherent event
generation. The shared corpus exercises 116 foreign payload variants across
incremental/rebuild attempts and offline/sink targets, preserving bytes and
refusing before applying a sink. The real non-git CLI checks JSON and TOON,
receipt reads and Neo4j flag paths. Packed acceptance repeats the foreign-data
and empty-history recovery cases on all six installation hosts.

The generation model covers empty, workspace-only, item-only and mixed replacement
streams. It compares cursor and versions with SDK mutation pages, checks the graph
against certified SDK reads, verifies the target CAS retains its expected revision,
and resumes sparse refresh after each rebuild. A checkpoint captured unchanged
from the pre-fix `1f44fbd` producer in `test/fixtures/event-projection-v1.json`
remains readable/exportable; no valid checkpoint schema is tightened.

Both defects have behavioral revert proof: classifying decoded null as missing
fails the foreign-data refusal regression, and restoring the prior-anchor fallback
fails empty-stream recovery with `SOURCE_INCOMPLETE`. Existing tests remain intact.
The package test and coverage runners explicitly use at most two workers.

## Authoritative items and custom type labels

Contribution ownership, identified by the SDK item ID, determines which node is
authoritative. Custom type names can equal graph labels such as `ExternalPmItem`,
`PmItem` or `PmFacet`; those names never grant placeholder precedence. The
contraction adapter recognizes the producer's `PmItem` role before classifying a
reference as unknown. Export, legacy sync and status reads supply the configured
item registry and schema to the SDK so custom folders are included.

The provenance regression covers references before and after their owners, all
structural relationship forms, missing targets, deletion and SDK restore, sparse
sink deltas, admission and explicit rebuild. Real CLI JSON/TOON paths exercise
refresh, receipt reads, export, contraction and status without a git executable.
Both Neo4j adapters retain the real item's native properties. The 500-sequence
SDK read-back model varies custom types as well as statuses; all six packed hosts
repeat the `ExternalPmItem` reference collision and both contraction formats.
The existing v1 checkpoint format remains unchanged.
Reverting materialization precedence, contraction classification or the configured
SDK read independently fails the corresponding regression; all three revert runs
returned exit 1 before restoring the fixes.

## Transaction ownership and source-preservation validation

Sparse refresh, legacy full/incremental sync and generated Cypher share guarded
ownership statement producers. Node and incident-relationship write locks precede
ownership reads; merge collisions recheck ownership under their lock. A forced
temporary property write is used because assigning an absent property to itself
can avoid the lock. Every refusal aborts the transaction, including temporary
lock writes. Only owned relationships are deleted, followed by plain node
`DELETE`; dense-node races are also covered by the database's commit constraint.
See [Neo4j concurrent access and delete semantics](https://neo4j.com/docs/operations-manual/current/database-internals/concurrent-data-access/).

The real two-session regression uses a checksum-verified Neo4j 5.26.27 distribution
in a non-git scratch directory, loopback networking, a 512 MiB heap and at most two
processors. It injects foreign-edge creation before and after every query on the
same non-git tracker, including sparse and dense database nodes. It observes actual
server lock waits, requests a typed rollback, verifies each foreign edge survives,
and verifies refused refreshes retain the checkpoint bytes. The 140 node-probe query
boundaries passed, with 96 confirmed server lock waits. A competing node-property
write independently proves the node lock while the peer creates its foreign edge.
An additional 140 pure-edge boundaries passed on SDK 2026.10.23 without that
extra property write, including ordinary/dense nodes and every sink/plan path:
80 confirmed server lock waits and 16 observed Closing-state rollbacks. Closing
observations are reported separately from lock waits. Those measured 280 cases
cover both writers. Default CI now also exercises explicit projection rebuild's
owned-edge reset and stale-node cleanup at every boundary, before collision and
packed-host checks. The Node 26 CI job
runs this fixture and packed npm/Bun global, npx/bunx and project-local consumers.
All six packed hosts passed eight real Neo4j foreign-record refusal cases each
(JSON/TOON, incremental/rebuild, absent/string temporary properties), retained the
checkpoint, and resumed sparse synchronization after explicit peer reconciliation.

All source validators use `scripts/tracker-fingerprint.ts`. It hashes every
regular authoritative filename and byte, including `schema/*.json`, Markdown,
hidden files and nested directories. Only reserved top-level SDK accelerator
directories are excluded. The 500-sequence property test covers create, edit,
rename and delete operations, CRLF and arbitrary bytes; schema-only changes must
invalidate source-preservation claims. Nonregular inputs fail closed.

Incremental node ownership checks seek exact touched IDs. Only node deletion
inspects every incident relationship; selected edge writes/removals lock and
recheck their own relationship. Shared facets do not cause unrelated incident-edge
sweeps during a node-only refresh. Late node/edge MERGE collision tests also
verify that foreign properties remain intact when they appear after preflight.
All four node-collision paths (sparse, legacy incremental/full and generated Cypher)
and the matching foreign-relationship collision passed against the real server.
The initial ownership-only packed run used SDK 2026.10.20. The recovery run below
uses SDK 2026.10.23; the validator derives the SDK version from the repository pin.

Behavioral revert proofs restore only the changed function or selection rule. The
old sparse transaction loses the actual peer edge at query boundary 7 (0 versus
1). The old extension-only source filter fails on the SDK snapshot manifest
entry `schema/fields.json`. Both restored implementations pass the positive
regressions above.

Removing only the node MERGE ownership predicate fails the late-node refusal
case. Removing only the relationship MERGE predicate fails the matching-foreign-
relationship refusal case. Each revert exits 1, and every original guard was
restored before rebuilding.

The pure-edge writer also rejects the old sparse transaction: reverting only
`syncProjectionDelta` on SDK 2026.10.23 loses the actual foreign edge at boundary
7 (0 versus 1), without any peer node-property write. The fixed function was
restored byte-for-byte; authored runtime and generated output remain `f6d81a6`.
That statement identifies the round-three evidence; the recovery implementation
below supersedes that runtime revision.

## Durable post-action recovery

A new state machine uses seed `0x175004` and 500 random crash sequences. It covers
initial admission and existing checkpoints; crashes after sink commit, checkpoint
publication and receipt publication; zero through three intervening source updates;
and ordinary refresh versus explicit rebuild. SDK read-back supplies every model
value, including replays of older inputs, CRLF, relationships, native fields,
custom types/status roles and ambient focus. Two complete runs passed all 500
sequences; an independent
transactional sink model equals the SDK full projection and retains foreign data.
The final shared-host rerun hit its 1800-second limit after the critical regression
and 200 reported sequences, without a reported assertion failure. That incomplete
run is a timeout, not a pass; exact-head CI reruns the complete suite.

Real Neo4j 5.26.27 validation covers all 24 combinations of three crash phases,
zero through three updates and both recovery modes. Each target is read through
the native driver and compared with a fresh full reference written through the
same public sink producer. All 24 pass, including a foreign edge on a retained
node. The apply-only SDK compatibility regression also passes both recovery modes.

An isolated copy with only `refreshEventProjection` reverted fails the source-
advance regression with `SINK_CONFLICT`; restoring the fixed function passes.
Recovery records use the existing v1 checkpoint validator and previous-producer
fixture remains readable/exportable. New malformed marker/foreign-intent records
fail without replacing other valid records.
An additional empty-history regression covers a committed generation with no
event coordinates, subsequent item creation, and explicit rebuild from an opaque
target revision. Both recovery modes pass.

Marker boundary cases also cover malformed and legacy native rows, canonical
head ordering, connection failures and a peer changing the revision after marker
inspection. Even a recovered no-op revalidates the sink CAS. The source event
version map uses native item identity without prototype-key collisions.

The previous-head CI exposed an exact-row consumer error when longer guarded
Cypher statements triggered the SDK's disclosed string compaction. The fixed
packed-host test recovers complete fields through SDK amount/cost controls and
still asserts every row equals the original, unchanged and in order. Its focused
regression passes; the guarded producer remains intact.

All six actual packed hosts pass on SDK 2026.10.23: npm/Bun global, npx/bunx and
npm/Bun project-local. They share one verified 52-file archive with SHA-256
`2bad3b24720e612f95a2f59dfb62b8e59fdc7d9db11edfed80c4390b1af50420`.
The run passes 48 real Neo4j foreign-record refusals and 24 crash recoveries across
JSON/TOON and ordinary/rebuild modes. Native values equal SDK source read-back;
foreign data remains intact. All nine runtime/declaration/map files matched
`bfe8899` when verified. Later declaration documentation and test-report changes
alter no executable JavaScript. The artifact stays private and untracked.

The focused explicit-rebuild interleaving matrix also passes all 96 boundaries:
node-probe and pure-edge writers, ordinary and dense nodes. It observes 60 actual
lock waits and eight separately reported Closing-state rollbacks; foreign edges
survive and refused refreshes retain their checkpoints. This adds to the earlier
280 measured boundaries. The PM-linked command uses none/snapshot context and
receives its explicitly owned fixture home only as an execution-time input.
