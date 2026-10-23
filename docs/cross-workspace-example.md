# Consent-scoped projection

Create two ordinary trackers (no git required), then add tasks with `pm create`.
Use a local manifest `projection.json`:

```json
{
  "scopes": [
    { "key": "delivery", "pmRoot": "delivery/.agents/pm" },
    { "key": "research", "pmRoot": "research/.agents/pm" }
  ],
  "consent": ["delivery", "research"],
  "evidence": [
    {
      "from": { "workspace": "research", "item": "study-1" },
      "to": { "workspace": "delivery", "item": "ship-1" },
      "type": "SUPPORTS",
      "consent": true
    }
  ]
}
```

Replace the example item IDs with exact IDs in the trackers. Paths resolve from
the manifest directory. Consent is explicit per source and per evidence edge.
The CLI reads only named sources using local OS/SDK permissions. It never
searches for other trackers or follows external relationship targets.

```sh
pm pm-graph project projection.json --limit 100 --json
pm pm-graph project projection.json --limit 100 --offset 100
```

Rows are discriminated nodes or edges. IDs encode both components, e.g.
`delivery::ship-1`; an identical `ship-1` in research has a different identity.
Facets and external placeholders are excluded. Missing local targets produce
opaque `DANGLING_RELATION` boundaries instead of invented nodes. Only consented
`SUPPORTS` and `EVIDENCE_FOR` edges may cross scopes, and both endpoints must
already be visible. Duplicate edges are collapsed.

`complete` describes source and evidence coverage. `receipt.omitted` and
`receipt.nextOffset` describe output paging separately. Even an empty authorized
tracker is readable; an unreadable tracker is not proof of an empty tracker.
Boundaries reference input slots only, never hidden IDs, titles, counts or source
exception text. No readable source yields `NO_READABLE_SCOPE` and exit 2.
Malformed input yields `INVALID_OPTIONS` and exit 2, each with a remedy.

The default page is 100 rows (maximum 1000), with at most 32 sources, 10000
explicit evidence edges and 100000 items per source. Source reads are complete
and sequential; output paging does not reduce input work. Pages re-read sources:
use stable inputs for recovery. This is not a globally atomic database snapshot.
The host also supplies JSON/TOON, output budgets and omission receipts; retain
both receipts when passing a compact projection to an agent.

For database-backed consumers, bind the host's existing tenant authorization and
SDK-certified complete reader. No credentials or raw SQL belong in the manifest:

```ts
import { projectWorkspaces } from "pm-graph";

const result = await projectWorkspaces([
  { key: "delivery", source: { kind: "directory", pmRoot: trackerRoot } },
  { key: "research", source: { kind: "database", read: readAuthorizedResearchComplete } },
], {
  consent: ["delivery", "research"],
  authorize: (scope) => coreAuthorization.canRead(scope.key),
  evidence: [],
  limit: 100,
});
```

The caller owns authorization, consent provenance, alias assignment and binding
the database reader to its exact tenant. The projection checks authorization
before invoking the reader and revalidates its complete-list certificate using
the pm SDK. Exceptions and incomplete database reads become opaque boundaries.
It does not install policy, grant access, write trackers, query Neo4j or traverse
unreadable sources. Do not expose the local CLI as a hosted authorization API.
