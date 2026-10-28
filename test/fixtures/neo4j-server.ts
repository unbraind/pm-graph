/** Isolated loopback-only Neo4j fixture, never a system service or hosted database. */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import neo4j from "neo4j-driver";
import { publicChildEnv } from "./public-child-env.ts";

/** Start an explicitly supplied unpacked distribution with bounded memory/CPU and stop only its child. */
export async function startNeo4j(home: string): Promise<{ uri: string; stop: () => Promise<void> }> {
  const marker: unknown = JSON.parse(readFileSync(join(home, "pm-graph-fixture.json"), "utf8"));
  if (marker === null || typeof marker !== "object" || Array.isArray(marker) || Object.keys(marker).length !== 2
    || !("owner" in marker) || marker.owner !== "pm-graph/isolated-neo4j-fixture" || !("version" in marker) || marker.version !== 1)
    throw new Error("An explicitly owned isolated fixture distribution is required");
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const address = socket.address();
  if (address === null || typeof address === "string") throw new Error("Fixture port unavailable");
  const port = address.port;
  await new Promise<void>((resolve) => { socket.close(() => resolve()); });
  writeFileSync(join(home, "conf/neo4j.conf"), [
    "server.default_listen_address=127.0.0.1", "server.default_advertised_address=127.0.0.1",
    `server.bolt.listen_address=127.0.0.1:${port}`, `server.bolt.advertised_address=127.0.0.1:${port}`,
    "server.http.enabled=false", "server.https.enabled=false", "dbms.security.auth_enabled=false",
    "server.memory.heap.initial_size=512m", "server.memory.heap.max_size=512m", "server.memory.pagecache.size=64m",
    "server.jvm.additional=-XX:ActiveProcessorCount=2", "db.transaction.timeout=120s", "db.lock.acquisition.timeout=30s",
  ].join("\n") + "\n");
  const child = spawn(join(home, "bin/neo4j"), ["console"], { cwd: home, detached: process.platform !== "win32", env: { ...publicChildEnv(), NEO4J_HOME: home, NEO4J_CONF: join(home, "conf") }, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = "";
  child.stdout.on("data", (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-4000); });
  child.stderr.on("data", (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-4000); });
  let exited = false;
  const exit = new Promise<void>((resolve) => { child.once("exit", () => { exited = true; resolve(); }); });
  const stop = async (): Promise<void> => {
    const signal = (name: NodeJS.Signals): void => {
      try { if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, name); else child.kill(name); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    if (!exited) signal("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([exit, new Promise<void>((resolve) => { timer = setTimeout(() => { if (!exited) signal("SIGKILL"); resolve(); }, 10000); })]); }
    finally { clearTimeout(timer); }
    await exit;
  };
  const uri = `bolt://127.0.0.1:${port}`;
  const client = neo4j.driver(uri, neo4j.auth.basic("fixture", "synthetic"), { connectionTimeout: 500, maxTransactionRetryTime: 0 });
  try {
    for (let attempt = 0; attempt < 1200; attempt++) {
      try {
        if (exited) throw new Error("Neo4j fixture exited before readiness");
        await client.verifyConnectivity();
        if (!exited && diagnostics.includes("Bolt enabled on") && diagnostics.includes(`:${port}`)) return { uri, stop };
        await new Promise((resolve) => { setTimeout(resolve, 250); });
      }
      catch { if (exited) throw new Error("Neo4j fixture exited before readiness"); await new Promise((resolve) => { setTimeout(resolve, 250); }); }
    }
    throw new Error("Neo4j fixture readiness timed out");
  } catch (error) { await stop(); throw new Error(`${String(error)}: ${diagnostics.replaceAll(home, "<fixture>")}`); }
  finally { await client.close(); }
}
