import { listAllComplete, readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { minimalBlockerCuts } from "./blocker-cuts.js";
/** Preserve refusal evidence in CLI JSON/TOON instead of losing it in error formatting. */
function commandRefusal(code, remedy, receipt, source) {
    return { ok: false, code, remediation: remedy, refusal: { code, remedy }, cuts: [],
        exit_code: code === "UNKNOWN_GOAL" ? 3 : 2, receipt, source };
}
/** Register the offline command; source reads are strict, complete, and extension-free. */
export function registerBlockerCuts(api, resolveRoot, project) {
    api.registerCommand({
        name: "pm-graph blocker-cuts",
        description: "Enumerate alternative minimal blocker frontiers for a goal with bounded completeness receipts.",
        read_output: { row_keys: ["cuts"] },
        arguments: [{ name: "goal", required: true, description: "Exact goal item id" }],
        examples: ["pm pm-graph blocker-cuts goal-id --max-cuts 16 --json"],
        failure_hints: ["Reload the full tracker for missing nodes; break cycles; increase search limits only when the receipt is partial."],
        run: async (context) => {
            const args = context.args ?? [];
            if (args.includes("--help") || args.includes("-h")) {
                return {
                    cuts: [],
                    usage: "pm pm-graph blocker-cuts <goal> [--max-states 20000] [--max-work 2000000] [--max-cuts 32] [--max-size 8] [--json]",
                    semantics: "All upstream prerequisite paths must intersect a cut. Intermediate tasks still require completion; immediatelyUnblocked reports direct eligibility.",
                    completeness: "Graph/source and search receipts are separate. Partial cuts are minimal; a partial list is not exhaustive.",
                };
            }
            const options = {};
            const positionals = [];
            const flags = new Map([
                ["--max-states", "maxStates"], ["--max-work", "maxWork"], ["--max-cuts", "maxCuts"], ["--max-size", "maxSize"],
            ]);
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg === "--json")
                    continue;
                const key = flags.get(arg);
                if (key) {
                    const value = args[++i];
                    if (!value || !/^\d+$/.test(value))
                        return commandRefusal("INVALID_OPTIONS", `Supply a positive integer after ${arg}.`);
                    options[key] = Number(value);
                }
                else if (arg.startsWith("-")) {
                    return commandRefusal("INVALID_OPTIONS", `Remove unsupported flag ${arg}; use blocker-cuts --help.`);
                }
                else
                    positionals.push(arg);
            }
            if (positionals.length !== 1)
                return commandRefusal("INVALID_OPTIONS", "Use pm pm-graph blocker-cuts <exact-goal-id>; see --help for budgets.");
            let graph;
            let source;
            try {
                const root = resolveRoot(context);
                const snapshot = await listAllComplete({}, { pmRoot: root, noExtensions: true });
                source = snapshot.complete_list;
                graph = project(snapshot.items, root);
                const registry = resolveRuntimeStatusRegistry((await readSettings(root)).schema);
                options.resolvedStatuses = [...registry.terminal_statuses];
                options.unresolvedStatuses = [...registry.by_id.keys()].filter((status) => !registry.terminal_statuses.has(status));
            }
            catch {
                return commandRefusal("SOURCE_INCOMPLETE", "Restore a readable complete tracker; run pm list --all --full --strict-read --output-limit unbounded --output-budget unbounded, then retry.");
            }
            const result = minimalBlockerCuts(graph, positionals[0], options);
            if (!result.ok)
                return { ...commandRefusal(result.refusal.code, result.refusal.remedy, result.receipt, source), goal: result.goal };
            return { ...result, source };
        },
    });
}
//# sourceMappingURL=blocker-cuts-command.js.map