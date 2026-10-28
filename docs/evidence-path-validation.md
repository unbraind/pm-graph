# Evidence-cost path validation

The public `unbraind/pm-graph` tracker at `c90d796` was copied from tracked
`origin/main` data to a scratch directory with no git repository. Authoritative
files were made read-only. `node scripts/validate-evidence-path.ts <copy>`
used certified SDK reads and verified the authoritative filename/byte fingerprint
before and after. No hosted or private tracker was accessed.

| Measurement | Result |
| --- | ---: |
| Source items / projected nodes | 111 / 111 |
| Relationships | 13 |
| Questions | 256 |
| Reachable / cost optimality proved | 37 / 37 |
| Unknown-cost receipts after removing all costs | 37 |
| Search-limited receipts at one unit of work | 5 |
| Maximum search work | 5 |
| Full graph JSON bytes | 44,456 |
| Median / maximum compact SDK JSON bytes | 344 / 656 |
| Elapsed time including SDK source read | 1,691.41 ms |
| Authoritative tracker bytes unchanged | yes |

Costs were deterministic synthetic caller declarations, not content-derived
estimates. Each selected query was compared with an independent exact Bellman
relaxation oracle. This source has no cheaper alternate witness for the sample:
zero longer-cheaper witnesses is an explicit limitation of the real corpus.
The adversarial synthetic fixture proves the feature's selection behavior: a
three-hop path costs four versus 102 for the shortest two-hop path.

The pure suite checks 1,000 seeded graphs against exhaustive simple-path
enumeration, including missing costs, integer extremes, bounded search,
zero-cost proofs, cycles, exact legacy identities and JSON/CRLF replay. The real
SDK suite checks 500 operation sequences under random ambient focus and custom
status roles. It preserves all SDK-read native fields and relationships through
current and older explanation inputs; normalization comes from the SDK. The
feature adds no native imports, synchronization, recovery plans or mutable
coordination records. Existing event-projection import/export/sync property and
interleaving suites remain in the complete CI gates.

Two behavioral reverts were run in a disposable copy: selecting only the
ordinary shortest-hop witness fails the cheaper-path assertion; accepting every
known-cost incumbent as optimal fails the bounded-search assertion. Restoring
the implementation passes all seven pure tests. The real CLI is exercised with
git absent from PATH and discovery capped above the scratch tracker.

Packed npm/Bun installation acceptance extends
`node test/event-projection-packed.validation.ts --evidence-path-only` to check both evidence-path output
formats, source certification and unknown-cost receipts through npm global,
Bun global, npx, bunx, npm project-local and Bun project-local hosts. The script
captures one archive, checks its SHA-512 integrity and required runtime/types/docs,
and tests those same bytes on every host.

Local validation runs only targeted tests, typecheck, lint, duplication and
docstrings. Full unchanged-threshold npm and Bun release gates run in CI; their
run URL and exact pass counts are recorded in the PR.

Final captured archive: 62 files, SHA-256
`621f5336b1a38860c50b5698f1de970be6ca83cfe6bf9cd3206d9aac6299041a`.
All six host modes passed both formats, unknown-cost/source receipts and strict
TypeScript consumer checks against the shipped declarations.
