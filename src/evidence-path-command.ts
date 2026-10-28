import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand, defineFlag, listAllComplete } from "@unbrained/pm-cli/sdk";
import { evidencePathInputFromGraph, evidencePathRefusal, explainEvidencePath } from "./evidence-path.ts";
import type { EvidencePathInput } from "./evidence-path.ts";
import { graphFromItems } from "./index.ts";
import type { CommandContext, ExtensionApi } from "./index.ts";

/** Read a bounded regular costs JSON file; never block on a FIFO or echo its contents. */
function readCosts(file: string): unknown {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 4 * 1024 * 1024) throw new Error("Expected a regular costs file <=4 MiB");
    const bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null);
      if (!read) break;
      size += read;
    }
    const after = fstatSync(fd);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw new Error("Costs file changed during read");
    return JSON.parse(bytes.subarray(0, size).toString("utf8")) as unknown;
  } finally { closeSync(fd); }
}

/** Register a certified offline read; host JSON/TOON output controls preserve explicit row omissions. */
export function registerEvidencePath(api: ExtensionApi, resolveRoot: (context: CommandContext) => string): void {
  api.registerCommand(defineCommand({
    name: "pm-graph evidence-path",
    description: "Explain a relationship with minimum declared item-read cost and a shortest-hop comparison.",
    arguments: [{ name: "from", required: true, description: "Exact starting item id" }, { name: "to", required: true, description: "Exact destination item id" }],
    flags: [
      defineFlag({ long: "--costs", value_name: "file.json", value_type: "string", description: "Required dense JSON array of {id,cost}; null/omitted rows are unknown; integer costs 0-1000000000." }),
      defineFlag({ long: "--edges", value_name: "types", value_type: "string", description: "Required comma-separated stored directed edge types, e.g. BLOCKED_BY,CHILD_OF." }),
      defineFlag({ long: "--max-settled", value_name: "integer", value_type: "number", description: "Per-search settlement cap 1-10000 (default 10000)." }),
      defineFlag({ long: "--max-work", value_name: "integer", value_type: "number", description: "Per-search queue-pop/edge cap 1-1000000 (default 100000)." }),
      defineFlag({ long: "--max-path-nodes", value_name: "integer", value_type: "number", description: "Atomic witness output cap 1-1000 (default 128)." }),
    ],
    read_output: { row_keys: ["rows"] },
    examples: ["pm pm-graph evidence-path goal-id prerequisite-id --edges BLOCKED_BY --costs costs.json --json"],
    failure_hints: ["Supply exact ids and explicit edge types; read optimality and both search receipts before treating the witness as cheapest. Costs are declarations, not observed reads."],
    run: async (context: CommandContext) => {
      const args = context.args ?? []; const options = context.options ?? {};
      if (args.length !== 2 || typeof options.costs !== "string" || !options.costs.trim())
        return evidencePathRefusal("INVALID_INPUT", "Use pm pm-graph evidence-path <from> <to> --edges <types> --costs <file.json>; see --help for bounds.");
      let costs: unknown;
      try { costs = readCosts(resolve(context.cwd ?? process.cwd(), options.costs)); }
      catch { return evidencePathRefusal("INPUT_UNAVAILABLE", "Supply a stable readable regular JSON costs file <=4 MiB; use a dense array of {id,cost} records, not clipped host output."); }
      let snapshot: Awaited<ReturnType<typeof listAllComplete>>;
      try { snapshot = await listAllComplete({}, { pmRoot: resolveRoot(context), noExtensions: true }); }
      catch { return evidencePathRefusal("SOURCE_INCOMPLETE", "Restore a complete readable tracker; verify pm list --all --full --strict-read --output-limit unbounded --output-budget unbounded, then retry."); }
      const graph = graphFromItems(snapshot.items, ".", new Map(), { includeFacets: false });
      const input = evidencePathInputFromGraph(graph, { from: args[0], to: args[1], costs: costs as EvidencePathInput["costs"],
        edgeTypes: typeof options.edges === "string" ? options.edges.split(",") : [],
        maxSettled: options.maxSettled as number | undefined, maxWork: options.maxWork as number | undefined, maxPathNodes: options.maxPathNodes as number | undefined });
      return { ...explainEvidencePath(input), source: snapshot.complete_list };
    },
  }));
}
