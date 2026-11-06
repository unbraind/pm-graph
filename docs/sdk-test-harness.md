# Extension test host

Positive registration tests use `createExtensionTestHarness` from
`@unbrained/pm-cli/sdk/testing`. Contract assertions inspect the real host's
command flags, exporter and service registrations. The shared `collectHandlers`
adapter dispatches through `harness.runCommand`, retaining the existing graph
assertions while supplying the SDK's globals and tracker-bound client.

`pm-graph project`, `pm-graph snapshot-impact`, `pm-graph refresh` and
`pm-graph evidence-path` tests use callbacks from the
SDK's registered command surface. These file-input commands intentionally test
relative filenames, explicit `cwd` and omitted contexts. The public
`RunRegisteredCommandForTestOptions` has no `cwd` override, so dispatching these
cases through that runner would change the behavior under test. Their packaged
CLI tests also exercise normal host dispatch and output receipts.

Graph direction, legacy context resolution, file validation, refusal codes,
diagram output and Neo4j fault injection remain package-owned assertions. The
SDK supplies the host; it does not define those graph policies. Blocker-cut
fault tests inject their domain dependencies into a real SDK registration and
use its registered callbacks to assert the identity of thrown projection defects.
The host-refusal tests deliberately inject an unavailable tracker accessor;
provider doubles exercise Neo4j boundaries rather than replace the host.

The harness regression uses an SDK-registered synthetic command alongside the
real graph extension on a non-git temp tracker. It verifies flag and schema
registration, injected SDK context, persisted mutation attribution, and the
packaged host's projected output receipt. The SDK runner's default client reads
its author from the ambient author context; `global.author` alone is not
forwarded to that client on the pinned SDK, so this fixture sets `PM_AUTHOR`
explicitly and restores it after the test.
