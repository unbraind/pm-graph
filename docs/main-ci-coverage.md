# Main CI coverage regression

Main commit `b790904` added evidence-path validation. The complete logs for
[main run 40788717831](https://github.com/unbraind/pm-graph/actions/runs/40788717831)
and [release PR 183 run 40890871950](https://github.com/unbraind/pm-graph/actions/runs/40890871950)
show passing parent tests followed by the actual failure:

```text
Error: coverage-gate: lines coverage 99.6965% is below 99.7%
```

The native coverage table rounds the measured percentage to `99.70`. The gate
correctly compares the underlying LCOV counts against the exact `99.7` floor.
The intentional nested fixture failure earlier in the logs is an expected
assertion in `test/coverage-gate.test.ts`, not the cause of the CI failure.

In the main Node 26 job, the npm release gate passes at 99.77% lines before the
Bun release gate fails. Both runs pass 450 tests and miss the validator's three
witness-counting lines. The Bun profile also misses five defensive
impact-envelope lines that the npm profile reports as covered. The new feature
therefore exhausts the Bun profile's remaining line-coverage margin. The fix
must exercise the missing witness behavior and retain the exact floor.

Local reproduction limit: the complete setup and sequential release gates on
unmodified `b790904`, its original lockfile, Node 26.12.1 and Bun 1.4.4 pass
450/450 tests at 99.77% lines in both phases. The historical aggregate failure
was not reproduced locally. The historical job logs establish the failing
profile; the deterministic regression supplies the missing behavior coverage,
and a separate LCOV regression reproduces the exact fractional-floor refusal.

The pinned PM CLI enables Node's compile cache programmatically. Node documents
[reduced coverage precision for cached functions](https://beta.docs.nodejs.org/module/module-compile-cache).
The measured runner forces `NODE_DISABLE_COMPILE_CACHE=1`, including for its
descendants. A real warmed-module regression verifies that an inherited cache
is not loaded and a later `enableCompileCache()` call returns `DISABLED`.

The new validator's cheaper/longer witness counters were not exercised. Its
existing integration test reads a tracker after a mutation sequence, so it
does not guarantee a graph with either kind of witness. The separate regression
in `test/validate-evidence-path.test.ts` creates five explicitly named items
and five directed relationships through the pinned SDK in a real tracker
outside git, with no git executable on PATH. It asserts 25 queries, 13 reachable
proofs, and exactly one cheaper witness that takes more hops. Sorted item IDs
give this witness cost 2478 versus 2592 for the shortest-hop route. It also checks
that validation leaves tracker bytes unchanged and emits only aggregate data.

Nested coverage runners capture their output and attach it to a failure's
error message. An expected rejection therefore stays quiet; an unexpected
rejection is reported under the failing parent test with its child diagnostics.
The outer runner continues streaming the full suite and explicitly announces
the subsequent receipt and exact-threshold checks.

The source inventory and all coverage thresholds remain unchanged. Validation
uses both `npm run release:check` and `bun run release:check`; the focused suite is:

```sh
node --test --test-concurrency=2 test/coverage-gate.test.ts test/validate-evidence-path.test.ts
```

The focused suite passes 26 tests with no failures, cancellations, skips or
TODOs. In a disposable worktree, restoring only the original `runCoverageGate`
makes the new diagnostic regression fail: leaked child output prevents the
parent receipt from being parsed. The fixed function is restored in `finally`,
after which the diagnostic and fractional-precision regressions pass again.

Full patched release gates on Node 26.12.1 and Bun 1.4.4 pass at the unchanged
thresholds, with 33 runtime sources reported in each run:

| Command | Tests | Lines | Branches | Functions |
| --- | ---: | ---: | ---: | ---: |
| `npm run release:check` | 453/453 | 99.7382% | 95.6970% | 100% |
| `bun run release:check` | 453/453 | 99.8071% | 95.7977% | 100% |

Both runs have zero failures, cancellations, skips and TODOs. The validator is
78/78 lines covered. In the npm profile, leaving its three witness-counting
lines uncovered would yield 99.6968%, below the 99.7% floor; this is a calculated
counterfactual, not a claimed historical full-run reproduction. Distribution
output was rebuilt and matches the committed files; dependency pins are unchanged.

At the CI waiting cutoff, [run 41098819654](https://github.com/unbraind/pm-graph/actions/runs/41098819654)
on implementation head `79e8519` has passing Node 22 and Windows jobs, with Node
26 still running. [CodeQL run 41098819653](https://github.com/unbraind/pm-graph/actions/runs/41098819653)
is queued. Semgrep, DeepScan and Hound pass; CodeRabbit explicitly skipped review.
An additional local Node 22 focused suite passes 26/26. PR 187 remains draft.
This handoff-only metadata update needs fresh CI on its resulting head;
implementation-head checks are not evidence for that newer head.
