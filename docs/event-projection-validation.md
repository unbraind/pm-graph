# Event-sparse projection validation

Public corpus: `unbraind/pm-graph` main at `4b5e7a1`, copied from tracked files
into a non-git scratch directory. Authoritative source files and directories were
made read-only after warming the SDK event index; writable projection storage was
separate. No source mutations were attempted by the feature.

| Measurement | Result |
| --- | ---: |
| Certified items | 108 |
| Projected nodes / edges | 203 / 372 |
| Admission mutation events | 1138 |
| Admission complete item scans | 1 |
| Caught-up complete item scans / item reads / events | 0 / 0 / 0 |
| Caught-up JSON receipt | 538 bytes |
| SDK event source | derived_index |
| Graph equals fresh certified full projection | yes |
| Authoritative filenames and bytes unchanged | yes |
| Admission plus catch-up wall time on a shared host | 1108 ms |

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

The storage interleaving test injects a competing refresher at all 12 declared
transition boundaries on the same tracker. The sink recovery test interrupts after
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
