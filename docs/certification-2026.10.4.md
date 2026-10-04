# PM CLI/SDK 2026.10.4 certification

CLI, pm-ops, pm-changelog and managed pm-github: **2026.10.4**. All development dependencies use exact versions. Consolidates Dependabot #118, #119, #120 and #121, including CodeQL SHA `2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2`.

## Gate receipts

Heavy commands ran under `flock /tmp/claude-1000/heavy-gate.lock`.

- `npm install`: refreshed npm lock and prepared merge drivers.
- `node --test test/prepare-merge-driver.test.ts`: 8/8 pass; byte-identical published launcher; malformed lookup regression fails the prior launcher and passes the new template.
- `node --test test/analytics.test.ts test/docstring-gate.test.ts`: 61/61 pass.
- `node --test test/impact-command.test.ts test/neo4j-retry-default.test.ts test/neo4j-retry-named.test.ts`: 12/12 pass.
- `node --test test/export-and-contract.test.ts`: 19/19 pass using the packed distribution, including custom tracker path `.pmx`.
- `pm test pm-graph-lcmc --run --only-index 1 --progress --json`: linked `env -u PM_PATH npm run release:check` passes, 301/301 tests, zero skips. The child clears the runner-injected project path so disposable fixtures initialize their own trackers, while the global tracker stays sandboxed.
- Duplication: 0/12116 lines, 50 sources, zero clone pairs at the unchanged 0% threshold.
- Coverage: 99.66% lines, 94.07% branches, 100% functions across four configured files. Statement coverage is unmeasured. Existing owner `pm-graph-6zil` remains open; thresholds were preserved, and the shared entry guard was added to the measured source set.
- `npx pm health --strict-exit --require-merge-drivers`: exit 0; one advisory finding covers two stale in-progress items.
- `npm audit --omit=dev`: zero vulnerabilities.
- `npm audit`: four high development vulnerability entries through braces/micromatch/fast-glob/pm-ops, owned by `pm-graph-g8uc`. Published braces 3.0.3 is vulnerable; 3.0.4 is unavailable. The suggested pm-ops downgrade would violate required pins. This remains a certification blocker.

The original contract fixture hit the CLI's fail-closed 10000-entry checkout limit. It now packs declared files once and installs the archive, preserving every command and output assertion. jscpd 5.4.0 clone findings were removed through shared guard and test-fixture helpers without exclusions or threshold changes.

Strict health detected an inherited chain mismatch in `pm-graph-3a1p` from merged #122. `pm history-repair pm-graph-3a1p --dry-run` and the audited repair rehashed two of 19 entries, repaired/skipped zero patches, preserved provenance, and retained the item byte-for-byte. `pm history pm-graph-3a1p --verify --strict-exit --json` passes. This proves chain validity, not a lossless merge attestation.

## Packed real-tracker acceptance

Copied this repository's `.agents/pm` into `/tmp/claude-1000/cert-wt/pm-graph-dogfood/.agents/pm`, packed with `npm pack`, and installed that tarball with `npm install --save-exact <archive> @unbrained/pm-cli@2026.10.4` and `npx -y @unbrained/pm-cli@2026.10.4 package install <archive> --project`.

For each launcher `npx -y @unbrained/pm-cli@2026.10.4` and `bunx --bun @unbrained/pm-cli@2026.10.4`, ran:

```sh
<launcher> pm-graph ping --json
<launcher> pm-graph export --format json --output graph-<runtime>.json
<launcher> pm-graph analyze --json
<launcher> pm-graph cycles --json
<launcher> pm-graph cypher --json
<launcher> pm-graph critical-path --json
<launcher> pm-graph impact pm-graph-lcmc --json
<launcher> pm-graph path pm-graph-lcmc pm-graph-lcmc --json
```

Both passed. Exports contained 185 nodes and 330 edges and included the certification owner. Validated generation timestamps independently, then asserted deep equality of remaining metadata, node/edge values and ordering. Deleted the scratch tracker afterwards. These offline commands do not establish live Neo4j acceptance.

## Managed GitHub preview

`pm github sync --repo unbraind/pm-graph --dry-run` exited 0 with `dryRun: true`, `wouldSync: 0`, `skipped: 1`, `planned: 1`; the CLI describes the skipped entry as already in sync/failed. No GitHub issues changed and scheduled sync remains disabled.
