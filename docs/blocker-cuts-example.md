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
