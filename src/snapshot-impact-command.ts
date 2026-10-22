import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { compareGraphSnapshots, snapshotImpactRefusal } from "./snapshot-impact.ts";
import type { SnapshotImpactOptions, SnapshotImpactRefusal } from "./snapshot-impact.ts";
import type { BlockerCutOptions } from "./blocker-cuts.ts";
import type { ExtensionApi, Graph } from "./index.ts";

const MAX_BYTES = 16 * 1024 * 1024;

/** Read an explicit regular JSON file with a hard byte cap, never resolving tracker/git state. */
function readSnapshot(file: string, side: "before" | "after"): { graph: Graph } | SnapshotImpactRefusal {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch { return snapshotImpactRefusal("INPUT_READ", "Supply readable before/after JSON snapshot files.", side); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return snapshotImpactRefusal("INPUT_READ", "Supply regular JSON files, not directories or devices.", side);
    if (stat.size > MAX_BYTES) return snapshotImpactRefusal("INPUT_LIMIT", "Supply snapshots of at most 16 MiB each, retaining the complete goal neighborhood.", side);
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes > MAX_BYTES) return snapshotImpactRefusal("INPUT_LIMIT", "Supply snapshots of at most 16 MiB each, retaining the complete goal neighborhood.", side);
    let value: unknown;
    try { value = JSON.parse(buffer.subarray(0, bytes).toString("utf8")); }
    catch { return snapshotImpactRefusal("INPUT_JSON", "Export complete JSON Graph SDK snapshots; do not use clipped host output or TOON as input.", side); }
    // Accept the Graph value or the existing export command's {graph: Graph} envelope.
    const graph = value !== null && typeof value === "object" && "graph" in value ? value.graph : value;
    return { graph: graph as Graph };
  } catch {
    return snapshotImpactRefusal("INPUT_READ", "Restore readable, stable regular snapshot files and retry.", side);
  } finally { closeSync(fd); }
}

/** Register a portable comparison command; the host supplies JSON/TOON and row-budget receipts. */
export function registerSnapshotImpact(api: ExtensionApi): void {
  api.registerCommand({
    name: "pm-graph snapshot-impact",
    description: "Compare goal reachability, minimal blocker cuts and evidence support between two explicit Graph SDK snapshots.",
    arguments: [{ name: "before", required: true, description: "Before JSON snapshot" }, { name: "after", required: true, description: "After JSON snapshot" }, { name: "goal", required: true, description: "Exact goal id in either snapshot" }],
    read_output: { row_keys: ["changes"] },
    examples: ["pm pm-graph snapshot-impact before.json after.json goal-id --limit 16 --json"],
    failure_hints: ["Use complete SDK projections; recover omitted changes with --offset; increase cut budgets only within hard caps."],
    run: async (context) => {
      const args = context.args ?? [];
      if (args.includes("--help") || args.includes("-h")) return {
        changes: [], usage: "pm pm-graph snapshot-impact <before.json> <after.json> <goal> [--limit 32] [--offset 0] [--max-work 2000000] [--cut-max-states 20000] [--cut-max-work 2000000] [--cut-max-cuts 32] [--cut-max-size 8] [--resolved-statuses closed,canceled] [--unresolved-statuses open,in_progress,blocked] [--json]",
        semantics: "Gating reachability in both directions; exhaustive minimal active blocker frontiers; SUPPORTS/EVIDENCE_FOR links into the goal or prerequisites. No snapshot storage or external content verification. Omitted rows are counted and recoverable; incomplete cut searches refuse comparison.",
      };
      const options: SnapshotImpactOptions = {};
      const cutOptions: BlockerCutOptions = {};
      const positions: string[] = [];
      const numeric = new Map<string, "limit" | "offset" | "maxWork">([["--limit", "limit"], ["--offset", "offset"], ["--max-work", "maxWork"]]);
      const cutNumeric = new Map<string, "maxStates" | "maxWork" | "maxCuts" | "maxSize">([["--cut-max-states", "maxStates"], ["--cut-max-work", "maxWork"], ["--cut-max-cuts", "maxCuts"], ["--cut-max-size", "maxSize"]]);
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--json") continue;
        const key = numeric.get(arg);
        const cutKey = cutNumeric.get(arg);
        if (key || cutKey) {
          const value = args[++i];
          if (!value || !/^\d+$/.test(value)) return snapshotImpactRefusal("INVALID_OPTIONS", "Supply an integer after each numeric flag; see snapshot-impact --help.");
          if (key) options[key] = Number(value);
          if (cutKey) cutOptions[cutKey] = Number(value);
        } else if (arg === "--resolved-statuses" || arg === "--unresolved-statuses") {
          const value = args[++i];
          if (!value || value.startsWith("-") || value.split(",").some((status) => !status.trim())) return snapshotImpactRefusal("INVALID_OPTIONS", "Supply nonempty comma-separated registry status ids after the status flag.");
          cutOptions[arg === "--resolved-statuses" ? "resolvedStatuses" : "unresolvedStatuses"] = value.split(",").map((status) => status.trim());
        } else if (arg.startsWith("-")) return snapshotImpactRefusal("INVALID_OPTIONS", "Remove unsupported flags; see snapshot-impact --help.");
        else positions.push(arg);
      }
      if (positions.length !== 3) return snapshotImpactRefusal("INVALID_OPTIONS", "Use pm pm-graph snapshot-impact <before.json> <after.json> <exact-goal-id>.");
      const cwd = context.cwd ?? process.cwd();
      const before = readSnapshot(path.resolve(cwd, positions[0]), "before");
      if ("ok" in before) return before;
      const after = readSnapshot(path.resolve(cwd, positions[1]), "after");
      if ("ok" in after) return after;
      return compareGraphSnapshots(before.graph, after.graph, positions[2], { ...options, cutOptions });
    },
  });
}
