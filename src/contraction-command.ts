import { defineCommand, defineFlag, listAllComplete } from "@unbrained/pm-cli/sdk";
import { contractGraph, contractionRefusal, contractionInputFromGraph } from "./contraction.ts";
import type { ContractionInput } from "./contraction.ts";
import { graphFromItems } from "./index.ts";
import type { CommandContext, ExtensionApi } from "./index.ts";

/** Register a certified, extension-free, read-only contraction over the source SDK view. */
export function registerContraction(
  api: ExtensionApi,
  resolveRoot: (context: CommandContext) => string,
): void {
  api.registerCommand(defineCommand({
    name: "pm-graph contract",
    description: "Collapse equal boundary behavior with expandable item IDs and original witness paths.",
    arguments: [{ name: "boundary", required: true, variadic: true, description: "Exact boundary item ids; all ordered pairs are preserved" }],
    flags: [
      defineFlag({ long: "--edges", value_name: "types", value_type: "string", description: "Required comma-separated stored directed edge types (for example BLOCKED_BY,CHILD_OF)." }),
      defineFlag({ long: "--limit", value_name: "integer", value_type: "number", description: "Returned rows, 1-1000 (default 100)." }),
      defineFlag({ long: "--offset", value_name: "integer", value_type: "number", description: "Row offset, 0-1000000 (default 0)." }),
      defineFlag({ long: "--expand", value_name: "group", value_type: "string", description: "Page original item IDs for a summary group in the current snapshot." }),
    ],
    read_output: { row_keys: ["rows"] },
    examples: ["pm pm-graph contract goal-id prerequisite-id --edges BLOCKED_BY,CHILD_OF --json"],
    failure_hints: ["Use exact ids and explicit edge types; reduce boundary count on WORK_LIMIT; restore a complete source on SOURCE_INCOMPLETE."],
    run: async (context: CommandContext) => {
      let snapshot: Awaited<ReturnType<typeof listAllComplete>>;
      let root: string;
      try {
        root = resolveRoot(context);
        snapshot = await listAllComplete({}, { pmRoot: root, noExtensions: true });
      } catch {
        return contractionRefusal("SOURCE_INCOMPLETE", "Restore a readable complete tracker; verify pm list --all --full --strict-read --output-limit unbounded --output-budget unbounded, then retry.");
      }
      const graph = graphFromItems(snapshot.items, ".", new Map(), { includeFacets: false });
      const options = context.options ?? {};
      const input = {
        ...contractionInputFromGraph(graph, context.args ?? [], typeof options.edges === "string" ? options.edges.split(",") : []),
        limit: options.limit, offset: options.offset, expand: options.expand,
      } as ContractionInput;
      const result = contractGraph(input);
      return { ...result, source: snapshot.complete_list };
    },
  }));
}
