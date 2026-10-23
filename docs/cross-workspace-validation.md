# Public tracker projection validation

Source: public `unbraind/pm-graph` main commit
`13c51065d436e643cab250137dc6b43be4fa645b`.
Only the committed tracker was extracted into a non-git scratch directory;
tracker files and directories were made read-only. No hosted data was accessed.

Replay: `node scripts/validate-cross-workspace.ts <public-tracker-copy>`.
The script uses `listAllComplete`, projects two independently qualified aliases,
adds a denied source capability, and fingerprints every source file before/after.

| Measurement | Result |
| --- | ---: |
| SDK-certified source items | 102 |
| Readable scope aliases | 2 |
| Qualified item nodes | 204 |
| Local relationships | 26 |
| Total / returned rows (limit 1000) | 230 / 230 |
| Omitted rows | 0 |
| Explicit unreadable boundaries | 1 |
| Denied source reads | 0 |
| JSON result bytes | 43900 |
| Projection elapsed time | 1670 ms |
| Source files byte-identical | yes |

This measurement demonstrates identity and boundary behavior on a copied public
tracker. The two aliases deliberately contain identical local item IDs. It does
not establish hosted deployment behavior, concurrent snapshot isolation or
large-fleet capacity. Synthetic regressions separately exercise a real SQLite
snapshot reader, per-edge consent, refusal remedies, denied-label suppression,
pagination, JSON/TOON and operation with no git executable on PATH.

Behavioral revert proof: replacing only `qualifyProjectionId` with unqualified
IDs makes the directory/SQLite regression fail (2 visible IDs instead of 4).
Bypassing only the authorization decision also makes that regression fail
(the denied scope loses its required boundary). Both mutations were restored;
the linked focused suite passes 3/3 tests. No coverage threshold was changed.
