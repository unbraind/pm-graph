# Choosing a blocker frontier

The goal `ship` depends on `review`. Review depends on both `tests` and `docs`.
All four items are open. A graph view can import `minimalBlockerCuts` without
starting Neo4j or invoking a CLI:

```ts
import { minimalBlockerCuts } from "pm-graph";
import type { Graph } from "pm-graph";

const graph: Graph = {
  generatedAt: "example",
  workspace: ".",
  projectKey: "example",
  nodes: ["ship", "review", "tests", "docs"].map((id) => ({
    id, labels: ["PmItem"], properties: { status: "open" },
  })),
  relationships: [["ship", "review"], ["review", "tests"], ["review", "docs"]]
    .map(([from, to]) => ({ from, to, type: "BLOCKED_BY", properties: {} })),
};
const result = minimalBlockerCuts(graph, "ship");
```

The returned alternatives are:

```json
[
  { "blockers": ["review"], "immediatelyUnblocked": true },
  { "blockers": ["docs", "tests"], "immediatelyUnblocked": false }
]
```

`review` is the smallest frontier. Finishing `docs` and `tests` is an alternative
upstream plan; review work must still finish before shipping. Resolving just
`tests` is insufficient because the independent docs path remains.

With default budgets this small graph has `search.complete: true`,
`minimumCardinality: 1`, and `completeThroughSize: 3`. With `maxSize: 1`, only
`review` is returned and `reason: "maxSize"` reports incomplete alternatives.
The minimum size is still proven. With `maxWork: 1`, there are no returned cuts,
`minimumCardinality: null`, and no claim that the goal is unblocked.

If `docs` references an absent prerequisite, the result is a typed
`INCOMPLETE_GRAPH` refusal containing that id. If `tests` depends on `review`,
the result is a `CYCLE` refusal with a closed witness. Resolve the data gap or
cycle and request a fresh snapshot before relying on an explanation.

Against an initialized tracker the equivalent command is:

```bash
pm pm-graph blocker-cuts ship --max-size 3 --json
```

The CLI additionally attaches the strict complete-list `source` certificate.
No repository is required, and this command does not mutate tracker items.

## Reproducing the acceptance evidence

In a source checkout, replay a complete public tracker copy whose input records
are read-only and which is outside any Git repository:

```bash
node scripts/validate-blocker-cuts.ts public-tracker/.agents/pm
```

The script checks input fingerprints before and after, evaluates every goal,
asserts the search budgets, and emits aggregate receipts. At implementation
commit `6ecf09e`, a copy of public pm-graph main at
`f46704ef4083287ba54766a8a03e6e09df7ec7d6` certified 99 items and projected
192 nodes / 349 relationships. All 99 goal searches were exhaustive, with zero
refusals and 99 cuts including empty cuts; one goal had a nonempty frontier.
Maximum search cost was one candidate state / three work units per goal.
JSON results were 626 bytes median / 657 bytes maximum. The final replay took
1441.54 ms on its test host; input records, settings and history were unchanged.
This mostly terminal corpus measures integration, rather than difficult search.

The independent path-hitting-set oracle validates every one of the 1024
five-node DAGs. Disabling only cut emission makes the three selected
oracle/chain/fork regressions fail; restoring it passes. The focused real-SDK
suite passes 11/11 tests, including empty-PATH, non-git CLI execution.

[CI acceptance](https://github.com/unbraind/pm-graph/actions/runs/39660868399)
passed 366/366 tests in each full npm and Bun release gate on Node 26, and
366/366 in Node 22 coverage. Aggregate coverage was 99.74% lines / 95.59%
branches / 100% functions, with 0% duplication at the existing thresholds.
The cut algorithm itself measured 100% in all three coverage dimensions.
Windows lifecycle checks passed too. These receipts describe that implementation
commit; future changes require fresh gate evidence.
