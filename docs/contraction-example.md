# Contract a graph while keeping its explanations

Given `start -> leaf-1 -> goal` and `start -> leaf-2 -> goal`, the two leaves
share the same declared behavior relative to boundaries `start` and `goal`.
They become one group with both original IDs. The boundaries remain separate.

```ts
import { contractGraph } from "pm-graph";

const input = {
  nodes: ["start", "leaf-1", "leaf-2", "goal"].map((id) => ({ id })),
  edges: [
    { from: "start", to: "leaf-1", type: "E" },
    { from: "start", to: "leaf-2", type: "E" },
    { from: "leaf-1", to: "goal", type: "E" },
    { from: "leaf-2", to: "goal", type: "E" },
  ],
  boundary: ["start", "goal"],
  edgeTypes: ["E"],
};
const result = contractGraph(input);
if (!result.ok) throw new Error(result.refusal.remedy);
// 4 source nodes -> 3 groups; all 4 ordered boundary pairs checked.
const leaves = result.rows.find((row) => row.kind === "group" && row.members.length === 2);
if (leaves?.kind === "group") {
  const page = contractGraph({ ...input, expand: leaves.id, limit: 1 });
  // Follow page.receipt.nextOffset using the SAME input for the next member.
  console.log(page);
}
```

For tracker-backed applications, obtain a certified complete, authorized source
with the pm SDK's `listAllComplete`, project it with `graphFromItems`, and adapt
it with `contractionInputFromGraph(graph, boundary, edgeTypes)`. This adapter only
copies IDs, arrows and unknown flags. Do not pass filtered or truncated source
reads while claiming completeness. Exact whitespace/CRLF IDs stay distinct via
reversible encoding at the core graph-index boundary.

```bash
pm pm-graph contract goal-id prerequisite-id --edges BLOCKED_BY,CHILD_OF
pm pm-graph contract goal-id prerequisite-id --edges BLOCKED_BY,CHILD_OF --json --limit 32
pm pm-graph contract goal-id prerequisite-id --edges BLOCKED_BY,CHILD_OF --expand g2 --offset 0 --limit 32
```

Stored arrows are literal, so `BLOCKED_BY` follows item to prerequisite. No
status is interpreted or excluded. Source bodies, descriptions and other native
fields stay in the tracker. A missing endpoint is retained as an unknown node;
an original cycle is retained as singleton nodes plus a cycle row. A summary
self-loop can come from different acyclic members and does not certify a cycle.
For arbitrary member-to-member questions, use the original SDK graph and IDs.

This view accepts no import or mutation and cannot be replayed into a tracker.
There is no idempotency key, frozen recovery plan, lease or shared mutable state.
JSON is the SDK serialization; TOON is CLI presentation, with no import promise.
The read-only tests use a non-git tracker, compare complete state read back through
the SDK to a reference snapshot across 500 seeded export/replay sequences, and
retain every native field present in that source. Another 500 seeded graph
operation sequences (6000 transitions) check independent reachability models,
older-input replays, whitespace/CRLF variants, relationships, unknown nodes and
finite output domains. Custom registry fixtures cover active, blocked, done and
canceled roles under generated names; contraction retains every status.

To reproduce the public-data validation, export only committed public tracker
records into a fresh plain scratch directory, then run:

```bash
node scripts/validate-contraction.ts "$PUBLIC_COPY/.agents/pm"
```

The script uses eight deterministic boundaries, independently checks every pair,
verifies input item/settings/history bytes are unchanged, and prints counts,
JSON byte sizes and elapsed time. It never prints source paths or item content.
The PR records the source commit and measured receipt. Source size reduction is
reported separately from output bytes, witness overhead, runtime and CI gates.
