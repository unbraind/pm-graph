# Public tracker validation

Source: public `unbraind/pm-graph` main at
`f46704ef4083287ba54766a8a03e6e09df7ec7d6`, validated 2026-10-21.
Only tracked tracker files were copied into a plain temporary directory, with
files and directories made read-only. No `.git` directory was copied.

The pinned SDK's `listAllComplete` certified the full corpus with extensions
disabled. `graphFromItems` projected item relationships/facets. The validation
adapter mapped real linked-doc records to explicit `SUPPORTS` edges; their
content was not fetched or attested. No source item was changed. Controlled
deletion/support-loss variants existed only as in-memory cloned graph values.
An independent recursive filename/byte digest matched before and after all reads.

| Measurement | Result |
| --- | ---: |
| Certified items / unique ids | 99 / 99 |
| Projected nodes, including explicit doc evidence | 212 |
| Projected relationships | 379 |
| Explicit linked-doc support assertions | 30 |
| Goals compared against reversed node/edge ordering | 99 |
| Reordering changes / refusals | 0 / 0 |
| Controlled prerequisite nodes removed | 1 |
| Removal changes | 3 |
| Removal change kinds | reachability removed; blocker cut removed; blocker cut added |
| Controlled support-edge removal changes | 1 |
| Page limit / first-page omissions | 1 / 2 |
| Rows recovered across all pages | 3 / 3 |
| Full controlled-removal JSON size | 1,502 bytes |
| Comparison/validation elapsed time after SDK read | 193.30 ms |
| Source-copy bytes and filenames unchanged | yes |

These are corpus-specific measurements under a busy host, not a scale or
latency guarantee. The separate installed-CLI regression initializes a real
non-git tracker using `pm init`, projects certified SDK reads before/after a
status transition, and exercises JSON, TOON, pagination, host output controls
and typed exit codes with `GIT_CEILING_DIRECTORIES` set and git absent from PATH.

To reproduce, copy the public tracker at the source commit into a non-git
directory, make that copy read-only, and run from the package checkout:

```bash
node test/snapshot-impact-public.validation.ts "$PUBLIC_TRACKER"
```

The script prints counts only; it asserts the copied source digest is unchanged.
The controlled graph deletions do not write to the tracker or either snapshot.
