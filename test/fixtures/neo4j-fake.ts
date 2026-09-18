/**
 * In-process Neo4j driver stand-in used by coverage tests.
 *
 * `src/index.ts` loads `neo4j-driver` through a dynamic import. The companion
 * ESM loader in this directory resolves that specifier to this module so the
 * real Bolt client never opens a socket, while the command handlers still run
 * their success and error-mapping paths against the driver's documented
 * JavaScript surface (session, executeRead/Write, records, Integer/Node/
 * Relationship/Path-shaped values).
 */

/** One Cypher invocation captured by the fake session. */
export type FakeNeo4jCall = {
  readonly mode: "read" | "write";
  readonly query: string;
  readonly params: Record<string, unknown> | undefined;
};

/** Record shape consumed by `toPlain` / `toNumber` in the extension. */
export type FakeNeo4jRecord = {
  readonly keys: readonly string[];
  get: (key: string) => unknown;
};

/** Result envelope the extension reads after `tx.run`. */
export type FakeNeo4jResult = {
  readonly records: FakeNeo4jRecord[];
};

/** Builds a record from a field map, matching neo4j-driver's `Record#get`. */
export function fakeRecord(fields: Record<string, unknown>): FakeNeo4jRecord {
  return {
    keys: Object.keys(fields),
    get(key: string): unknown {
      return fields[key];
    },
  };
}

/** Neo4j Integer stand-in: `toPlain` / `toNumber` detect `toNumber()`. */
export function fakeInteger(n: number): { toNumber: () => number } {
  return {
    toNumber(): number {
      return n;
    },
  };
}

/** Neo4j Node stand-in: labels + properties (+ optional elementId). */
export function fakeNode(
  labels: string[],
  properties: Record<string, unknown>,
  elementId?: string,
): { labels: string[]; properties: Record<string, unknown>; elementId?: string } {
  return { labels, properties, elementId };
}

/** Neo4j Relationship stand-in with start/end element ids. */
export function fakeRelationship(
  type: string,
  properties: Record<string, unknown>,
  ids?: { elementId?: string; startNodeElementId?: string; endNodeElementId?: string },
): {
  type: string;
  properties: Record<string, unknown>;
  elementId?: string;
  startNodeElementId?: string;
  endNodeElementId?: string;
} {
  return {
    type,
    properties,
    elementId: ids?.elementId,
    startNodeElementId: ids?.startNodeElementId,
    endNodeElementId: ids?.endNodeElementId,
  };
}

/** Neo4j Path stand-in: start, end, segments, optional length. */
export function fakePath(
  start: unknown,
  end: unknown,
  segments: Array<{ start: unknown; relationship: unknown; end: unknown }>,
  length?: number,
): { start: unknown; end: unknown; segments: Array<{ start: unknown; relationship: unknown; end: unknown }>; length?: number } {
  return { start, end, segments, length };
}

type QueryFn = (query: string, params?: Record<string, unknown>) => FakeNeo4jResult;

type FakeState = {
  read: QueryFn;
  write: QueryFn;
  failWith: unknown | undefined;
  calls: FakeNeo4jCall[];
  lastUri: string | undefined;
  lastConfig: Record<string, unknown> | undefined;
  lastSessionConfig: Record<string, unknown> | undefined;
  closed: boolean;
};

const state: FakeState = {
  read: () => ({ records: [] }),
  write: () => ({ records: [fakeRecord({ deleted: fakeInteger(2), count: 0 })] }),
  failWith: undefined,
  calls: [],
  lastUri: undefined,
  lastConfig: undefined,
  lastSessionConfig: undefined,
  closed: false,
};

/** Restore default handlers, captured calls, and failure injection. */
export function resetFakeNeo4j(): void {
  state.read = () => ({ records: [] });
  state.write = () => ({ records: [fakeRecord({ deleted: fakeInteger(2), count: 0 })] });
  state.failWith = undefined;
  state.calls = [];
  state.lastUri = undefined;
  state.lastConfig = undefined;
  state.lastSessionConfig = undefined;
  state.closed = false;
}

/** Override the read (`executeRead`) Cypher handler. */
export function setFakeNeo4jRead(handler: QueryFn): void {
  state.read = handler;
}

/** Override the write (`executeWrite`) Cypher handler. */
export function setFakeNeo4jWrite(handler: QueryFn): void {
  state.write = handler;
}

/** Throw this value from the next executeRead/executeWrite. */
export function setFakeNeo4jFail(err: unknown | undefined): void {
  state.failWith = err;
}

/** Cypher calls observed since the last reset. */
export function getFakeNeo4jCalls(): readonly FakeNeo4jCall[] {
  return state.calls;
}

/** Last `driver(uri, auth, config)` config object. */
export function getFakeNeo4jLastConfig(): Record<string, unknown> | undefined {
  return state.lastConfig;
}

/** Last `driver.session(config)` argument. */
export function getFakeNeo4jLastSessionConfig(): Record<string, unknown> | undefined {
  return state.lastSessionConfig;
}

/** Last URI passed to `driver()`. */
export function getFakeNeo4jLastUri(): string | undefined {
  return state.lastUri;
}

/** Whether `driver.close` / `session.close` ran. */
export function wasFakeNeo4jClosed(): boolean {
  return state.closed;
}

function runWork(
  mode: "read" | "write",
  work: (tx: { run: (query: string, params?: Record<string, unknown>) => Promise<FakeNeo4jResult> }) => Promise<unknown>,
): Promise<FakeNeo4jResult> {
  if (state.failWith !== undefined) {
    return Promise.reject(state.failWith);
  }
  const tx = {
    async run(query: string, params?: Record<string, unknown>): Promise<FakeNeo4jResult> {
      state.calls.push({ mode, query, params });
      return mode === "read" ? state.read(query, params) : state.write(query, params);
    },
  };
  return Promise.resolve(work(tx)).then((result) => result as FakeNeo4jResult);
}

/**
 * Auth token factory matching `neo4j.auth.basic`.
 *
 * @param user - Principal stored on the token.
 * @param password - Credentials stored on the token.
 * @returns A basic-auth token object.
 */
export function basic(user: string, password: string): { scheme: "basic"; principal: string; credentials: string } {
  return { scheme: "basic", principal: user, credentials: password };
}

export const auth = { basic };

/**
 * Build a driver whose sessions speak the fake Cypher handlers.
 *
 * @param uri - Bolt URI the extension read from the environment.
 * @param _authToken - Auth token from `auth.basic` (unused).
 * @param config - Driver config the extension assembled (timeouts, pool).
 * @returns A session factory compatible with the extension's Neo4jDriver type.
 */
export function driver(
  uri: string,
  _authToken: unknown,
  config?: Record<string, unknown>,
): {
  session: (sessionConfig?: Record<string, unknown>) => {
    executeRead: (work: (tx: { run: (query: string, params?: Record<string, unknown>) => Promise<FakeNeo4jResult> }) => Promise<unknown>) => Promise<FakeNeo4jResult>;
    executeWrite: (work: (tx: { run: (query: string, params?: Record<string, unknown>) => Promise<FakeNeo4jResult> }) => Promise<unknown>) => Promise<FakeNeo4jResult>;
    close: () => Promise<void>;
  };
  close: () => Promise<void>;
} {
  state.lastUri = uri;
  state.lastConfig = config;
  if (process.env.PM_GRAPH_TEST_DROP_URI === "1") delete process.env.NEO4J_URI;
  return {
    session(sessionConfig?: Record<string, unknown>) {
      state.lastSessionConfig = sessionConfig;
      return {
        executeRead(work) {
          return runWork("read", work);
        },
        executeWrite(work) {
          return runWork("write", work);
        },
        async close() {
          state.closed = true;
          if (process.env.PM_GRAPH_TEST_CLOSE_FAIL === "1") throw new Error("Neo4j session close failed");
        },
      };
    },
    async close() {
      state.closed = true;
      if (process.env.PM_GRAPH_TEST_CLOSE_FAIL === "1") throw new Error("Neo4j driver close failed");
    },
  };
}

const api = { driver, auth };
export default api;
