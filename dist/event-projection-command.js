import path from "node:path";
import { eventProjectionRefusal, refreshEventProjection, readEventProjectionReceipt } from "./event-projection.js";
/** Register bounded JSON/TOON refresh receipts without embedding the full persisted graph. */
export function registerEventProjection(api, resolveRoot, neo4j) {
    api.registerCommand({
        name: "pm-graph refresh",
        description: "Refresh an owned offline/Neo4j projection from SDK mutation pages with exact work receipts.",
        arguments: [{ name: "checkpoint", required: true, description: "Owned checkpoint JSON (created on first admission)" }],
        read_output: { row_keys: ["work"] },
        examples: ["pm pm-graph refresh projection.json --json", "pm pm-graph refresh projection.json --neo4j --rebuild"],
        failure_hints: ["CURSOR_GAP needs explicit --rebuild; preserve foreign files; see docs/event-projection-example.md."],
        run: async (context) => {
            const args = context.args ?? [];
            if (args.includes("--help") || args.includes("-h"))
                return { work: [], usage: "pm pm-graph refresh <checkpoint.json> [--receipt] [--rebuild] [--neo4j] [--limit 100] [--offset 0] [--max-events 1000000] [--json]" };
            let receiptOnly = false;
            let checkpoint;
            const options = {};
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg === "--json")
                    continue;
                if (arg === "--receipt")
                    receiptOnly = true;
                else if (arg === "--rebuild")
                    options.rebuild = true;
                else if (arg === "--neo4j")
                    options.sink = neo4j;
                else if (arg === "--limit" || arg === "--offset" || arg === "--max-events") {
                    const value = args[++i];
                    if (!value || !/^\d+$/.test(value))
                        return eventProjectionRefusal("INVALID_INPUT");
                    options[arg === "--limit" ? "limit" : arg === "--offset" ? "offset" : "maxEvents"] = Number(value);
                }
                else if (arg.startsWith("-") || checkpoint !== undefined)
                    return eventProjectionRefusal("INVALID_INPUT");
                else
                    checkpoint = arg;
            }
            if (receiptOnly && (options.rebuild || options.sink || options.maxEvents !== undefined))
                return eventProjectionRefusal("INVALID_INPUT");
            if (!checkpoint)
                return eventProjectionRefusal("INVALID_INPUT");
            try {
                if (receiptOnly)
                    return await readEventProjectionReceipt(path.resolve(context.cwd ?? process.cwd(), checkpoint), options.limit, options.offset);
                return await refreshEventProjection({ pmRoot: resolveRoot(context), stateFile: path.resolve(context.cwd ?? process.cwd(), checkpoint), ...options });
            }
            catch {
                return eventProjectionRefusal("SOURCE_INCOMPLETE");
            }
        },
    });
}
//# sourceMappingURL=event-projection-command.js.map