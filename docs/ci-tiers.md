# Fleet CI v2

Required checks remain `test (22)`, `test (26)` and
`windows-prepare-lifecycle`. PRs and dispatch use quick depth; superseded PRs
cancel. Ubuntu jobs have 25-minute limits; Windows lifecycle has eight minutes,
versus its measured 2m26s execution. Dispatch always selects code checks.

| Check | Code PR 22 | Code PR 26 | Docs/tracker-only | Deep 22 + 26 |
| --- | --- | --- | --- | --- |
| npm ci / prepare merge drivers | yes | yes | yes, plus Windows install | yes |
| Pinned project pm-github install | yes | yes | yes | yes |
| Strict tracker health / required merge drivers | — | yes | both Ubuntu + Windows | yes |
| Brand values check | — | gate | — | npm + Bun |
| Typecheck / lint / zero duplication / docstrings | — | gate | — | npm + Bun |
| Build / test typecheck / test suite | quick | quick via coverage | build and applicable suites | full npm + Bun |
| Committed dist tracked, clean rebuild, zero drift | — | yes | dist changes select code | both |
| Coverage, unchanged 99.7/94.9/100 lines/branches/functions | — | quick | — | full npm + Bun |
| Production dependency audit | — | gate | — | npm + Bun |
| Pack dry-run / declared distribution | — | gate | both Ubuntu jobs | npm + Bun |
| Changelog consistency | — | gate | both Ubuntu jobs | npm + Bun |
| Publish attestation | via tests | gate | both Ubuntu jobs | npm + Bun |
| Release changelog date | via tests | gate | — | npm + Bun |
| README analytics / snapshot docs / executable example contracts | via tests | via coverage | both Ubuntu jobs | full npm + Bun |
| Real packed export/install and host-output recovery | via tests | via coverage | both Ubuntu jobs | full npm + Bun |
| Bun install / compiled module / bunx CLI smoke | — | yes | — | original graph install + full Bun gate |
| Windows prepare, merge health, command parser, coverage paths/receipts | separate required job | separate required job | same platform job | retained in PR |
| Java / checksum-verified isolated live Neo4j interleavings | — | — | — | Node 26 |
| CodeQL | matching paths | separate workflow | filtered | main matching paths and weekly scan |

The cheap path retains every current docs/tracker input contract: identity/private
path audit, strict health, attestation (including shebangs in any tracked file),
changelog, metadata/vocabulary, README analytics and snapshot-impact assertions,
the executable snapshot example, and real tarball consumer/output tests. It
builds because those tests load the compiled extension, and puts the pinned pm
CLI on PATH to prevent availability-based skips. Any JS/TS source, including
under docs/tracker, and any committed dist artifact selects code checks. There
is no separate secret gate. Source-only brand, lint and duplication gates remain
in Node 26 and deep; their thresholds and source scope are unchanged.

The manual `test/event-projection-packed.validation.ts` already describes six
npm/Bun global/project and npx/bunx acceptance hosts, but it is outside the
original release gate. PR CI therefore explicitly runs Bun graph install, a
compiled-module load and bunx host CLI smoke. This smoke does not claim to
certify all packed installation hosts. The old live Neo4j check is retained in
deep, with its Java setup, pinned archive checksum and isolated fixture cleanup.

Deep runs on main pushes, dispatch and daily at 01:33 UTC, away from release
(03:23 and hourly :41) and weekly CodeQL (Monday 05:05). Distinct `deep (22)`
and `deep (26)` jobs each run full npm and Bun release gates with
`PM_TEST_DEPTH=full`, `PM_TEST_TIME_SCALE=3`, 120-minute limits and cancellation
per ref. Local runners use persistent npm cache and installed Bun, with version
logging; hosted fallback restores npm cache and installs Bun. `PM_LOCAL_DEEP=off`
selects hosted Ubuntu; otherwise jobs queue for `self-hosted,pm-local`.
The health harness remains bounded at 120 seconds in PRs and 360 in deep.
Release-owned workflows, verifiers, protection and variables are unchanged.

Depth defaults to full. Quick keeps the first 50/500, 100/1000 and 25/100 seeded
cases, with identical seed generation and assertions. The 48 deterministic
post-action crash combinations all fit in the 50-case prefix. Fixed 3000/10000
item, graph/work/size and pagination boundaries stay full size. Scaled harness
timeouts validate finite positive factors before spawning and round up to integer
milliseconds. No product deadline, lock budget or driver retry setting is scaled.
The projection scale test bounds identity reads by item count rather than wall
time; the driver error-path test uses a scaled runner timeout with its original
connection/retry configuration.

## Measurements

Owner fleet baseline: 39,929 runner-minutes in 24 hours; PR wall time commonly
45–90 minutes with about 28 minutes queueing. Successful main run
[43679565402](https://github.com/unbraind/pm-graph/actions/runs/43679565402)
reported up to 106.357 seconds for the 500-case post-action model and
118.042 seconds for non-git CLI acceptance. Ubuntu Node 22 used 10m43s execution /
18m23s wall; Node 26 used 16m15s execution / 36m30s wall. Windows used 2m26s
execution / 6m04s wall. Full depth is not rerun locally. Local quick results and
PR job observations are recorded in the tracker and PR without treating queued
runs as success.

The contraction model checks transition totals against generated sequences times
twelve, rather than a fixed full-depth total. Linked integration runs use
`--pm-context none --override-linked-pm-context --workspace-context snapshot
--override-linked-workspace-context` because
their CLI fixtures already own isolated trackers. The retained project extension
installer also prevents local host-version cache skew before strict health.

Local quick coverage passed 453 tests with zero skips in 828.63 seconds
(13m49s), including complete-suite receipts and all 33 runtime source files:
99.74% lines, 95.59% branches, 100% functions. The snapshot-linked touched
suite passed 127/127 in 293.121 seconds. No late-seed coverage gap reproduced.
For PR head `01c02d2`, Windows lifecycle passed in 195 seconds queue-inclusive
wall time (161 seconds execution); Ubuntu required checks remained queued.
Hosted full and overloaded-local quick timings are not directly comparable.
