# Evidence-cost relationship explanations

The graph below has two witnesses from `goal` to `source`. Reading `expensive`
costs 100 units; all other items cost one. The two-hop path costs 102, while the
three-hop witness costs four.

```typescript
import { explainEvidencePath } from "pm-graph";
import type { EvidencePathInput } from "pm-graph";

const input: EvidencePathInput = {
  nodes: ["goal", "expensive", "cheap-a", "cheap-b", "source"].map(id => ({ id })),
  edges: [
    { from: "goal", to: "expensive", type: "SUPPORTS" },
    { from: "expensive", to: "source", type: "SUPPORTS" },
    { from: "goal", to: "cheap-a", type: "SUPPORTS" },
    { from: "cheap-a", to: "cheap-b", type: "SUPPORTS" },
    { from: "cheap-b", to: "source", type: "SUPPORTS" },
  ],
  from: "goal", to: "source", edgeTypes: ["SUPPORTS"],
  costs: ["goal", "expensive", "cheap-a", "cheap-b", "source"].map(id => ({
    id, cost: id === "expensive" ? 100 : 1,
  })),
};
const result = explainEvidencePath(input);
if (!result.ok) throw new Error(`${result.refusal.code}: ${result.refusal.remedy}`);
console.log(result.optimality); // proved
console.log(result.rows[0].path); // goal, cheap-a, cheap-b, source
console.log(result.rows.map(row => row.cost)); // [4, 102]
```

Set `expensive` to `null` or omit its cost row: the selected known-cost witness
still costs four, the comparison cost is unknown, and optimality becomes
`unknown-costs`. Its optimistic lower bound is two, so four cannot be certified
as the minimum. A missing estimate is never treated as a free observed read.
With all costs restored, `maxWork: 1` returns the valid shortest-hop incumbent
with `search-limited`. The all-zero-cost case can prove optimality even at this
bound: no nonnegative path can improve zero.

For an initialized tracker with those exact ids and stored `SUPPORTS` arrows,
save the `input.costs` array to `costs.json` and run:

```bash
pm pm-graph evidence-path goal source --edges SUPPORTS --costs costs.json --json
pm pm-graph evidence-path goal source --edges SUPPORTS --costs costs.json
```

This also works without git and with an explicit tracker selected by the host's
`--pm-path`. Every result concerns that source projection only. Supply a new
query after the source or cost estimates change; results are not replayable write
plans. No new import, export-to-storage, synchronization or persistent cost store
is introduced. Final context selection, shared-source deduplication and packing
remain the caller's or pm-context's responsibility.
