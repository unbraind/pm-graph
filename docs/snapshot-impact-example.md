# Snapshot change impact

Capture and certify tracker reads with the backend SDK, then project them with
`graphFromItems`. Keep both explicit values immutable. `Graph` is the portable
input boundary; core snapshot storage manifests alone do not contain graph rows.

```ts
import { listAllComplete } from "@unbrained/pm-cli/sdk";
import { compareGraphSnapshots, graphFromItems } from "pm-graph";
import type { Graph, SnapshotImpactResult } from "pm-graph";

const source = await listAllComplete({}, {
  pmRoot: ".agents/pm",
  noExtensions: true,
});
const before: Graph = graphFromItems(source.items, ".", new Map());
// Read again after work has progressed, potentially on another backend.
const laterSource = await listAllComplete({}, {
  pmRoot: ".agents/pm",
  noExtensions: true,
});
const after: Graph = graphFromItems(laterSource.items, ".", new Map());
const impact: SnapshotImpactResult = compareGraphSnapshots(
  before, after, "goal-id", { limit: 16 },
);
if (!impact.ok) {
  console.error(impact.refusal.code, impact.refusal.remedy);
} else {
  console.log(impact.changes, impact.receipt.output);
}
```

For a goal blocked by `review`, itself blocked by `tests`, the earlier minimal
frontiers are `[review]` and `[tests]`. Completing `tests` removes the latter
frontier; structural reachability stays unchanged because the relationship still
exists. Removing `tests` and its incident edges instead also reports lost upstream
reachability, retaining the earlier title/status. The `[review]` frontier remains.

A backend can supply evidence explicitly:

```ts
before.nodes.push({
  id: "proof-1", labels: ["Evidence"],
  properties: { title: "Acceptance run receipt" },
});
before.relationships.push({
  from: "proof-1", to: "tests", type: "SUPPORTS", properties: {},
});
```

Losing that edge, or disconnecting `tests` from the goal, reports
`evidence-removed` with both the proof and target's earlier explanation. Duplicate
`SUPPORTS`/`EVIDENCE_FOR` assertions for the same pair count as one support fact.
Changing evidence text alone is an ordinary metadata edit and creates no support
change. The presence of a support edge does not attest that the content passed.

Save projected values as JSON with your backend's export workflow. For the local
tracker, full graph exports can also be requested explicitly:

```bash
pm pm-graph export --include-closed --json --output-limit unbounded --output-budget unbounded > before.json
# After a later complete source read:
pm pm-graph export --include-closed --json --output-limit unbounded --output-budget unbounded > after.json
pm pm-graph snapshot-impact before.json after.json goal-id --json
pm pm-graph snapshot-impact before.json after.json goal-id --limit 1
```

`--json` preserves the SDK Graph schema, including `relationships` and
`properties`. Both exports request unbounded host output to retain every node
and relationship. `--format json` renders a different schema for visualization.

The comparison without `--json` defaults to TOON. An abbreviated successful receipt is:

```json
{
  "total": 3,
  "returned": 1,
  "omitted": 2,
  "offset": 0,
  "nextOffset": 1,
  "complete": false
}
```

Repeat with `--offset 1` and the same immutable snapshots to recover the next
page. A later page's `omitted` also counts earlier rows not present on that page.
`changed` describes the entire comparison even when the requested page is empty.
Host `--output-include`, `--output-limit`, `--output-budget` and continuation
receipts can further constrain the selected page.

An incomplete cut search returns `CUT_SEARCH_INCOMPLETE` without change rows.
Its remedy names the exhausted cut budget. Increase that budget within its hard
cap, or obtain a smaller complete goal cone. Do not treat truncated cut lists as
proof of removed alternatives. `CUT_REFUSED` retains the underlying `cutCode`
(such as `CYCLE` or `INCOMPLETE_GRAPH`) and remedy.
