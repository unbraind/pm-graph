import neo4j from "neo4j-driver";
import type { AuthToken, Config, ManagedTransaction, QueryResult, SessionConfig } from "neo4j-driver";

/** Observer runs before/after every actual query in the actual driver's managed transaction. */
export type LiveObserver = (phase: "before" | "after", query: string, parameters: Record<string, unknown> | undefined) => Promise<void>;
let observer: LiveObserver | undefined;

/** Arm one deterministic competing-session injection without replacing database behavior. */
export function observeLiveQueries(value: LiveObserver | undefined): void { observer = value; }

/** Run one real query with the same observation boundaries for generated plans and package sync. */
export async function runLiveObserved(tx: ManagedTransaction, query: string, parameters?: Record<string, unknown>): Promise<QueryResult> {
  await observer?.("before", query, parameters);
  const result = await tx.run(query, parameters);
  await observer?.("after", query, parameters);
  return result;
}

/** Wrap only query boundaries; every transaction, lock, commit and rollback belongs to Neo4j. */
function driver(uri: string, auth: AuthToken, config?: Config) {
  const actual = neo4j.driver(uri, auth, config);
  return {
    session(options?: SessionConfig) {
      const session = actual.session(options);
      return {
        executeRead: <T,>(work: (tx: ManagedTransaction) => Promise<T>) => session.executeRead(work),
        executeWrite: <T,>(work: (tx: { run: (query: string, params?: Record<string, unknown>) => Promise<QueryResult> }) => Promise<T>) => session.executeWrite(async (tx) => work({
          run: (query, parameters) => runLiveObserved(tx, query, parameters),
        })),
        close: () => session.close(),
      };
    },
    close: () => actual.close(),
  };
}
export default { ...neo4j, driver };
