/** Machine-readable completion events, independent of user console output and TAP summaries. */
import type { TestEvent } from "node:test/reporters";

/** Serialize real runner outcomes, including skipped suites and source locations of declared tests. */
export default async function* completionReporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  for await (const event of source) {
    if (event.type === "test:pass" || event.type === "test:fail" || event.type === "test:summary") {
      yield `${JSON.stringify(event)}\n`;
    }
  }
}
