/** Synthetic Neo4j transport fixture; this does not replace any pm SDK behavior. */
import { readFileSync } from "node:fs";

/** Build the public record interface consumed by the provider adapter. */
function record(fields: Record<string, unknown>) {
  return { keys: Object.keys(fields), get: (key: string) => fields[key] };
}

/** Return deterministic read responses derived from the temporary tracker IDs. */
function response(query: string) {
  const rows = JSON.parse(readFileSync(process.env.READ_OUTPUT_NEO4J_ROWS!, "utf8")) as Array<{ id: string; title: string }>;
  if (query.includes("count(")) return { records: [record({ count: rows.length })] };
  if (query.includes("PmGraphSync")) return { records: [] };
  if (query.includes("RETURN center")) return { records: rows.slice(1).map((row) => record({
    center: { labels: ["PmItem"], properties: rows[0] },
    neighbor: { labels: ["PmItem"], properties: row },
    r: { type: "BLOCKED_BY", properties: {} }, relType: "BLOCKED_BY", direction: "incoming",
  })) };
  return { records: rows.map((row) => record(row)) };
}

export const auth = { basic: (_user: string, _password: string) => ({}) };
/** Provide only read sessions; a writer reaching this fixture is a test failure. */
export function driver() {
  return {
    session: () => ({
      executeRead: (work: (tx: { run: (query: string) => Promise<ReturnType<typeof response>> }) => unknown) => work({ run: async (query) => response(query) }),
      executeWrite: () => { throw new Error("Writer reached the provider despite read-control rejection"); },
      close: async () => {},
    }),
    close: async () => {},
  };
}
