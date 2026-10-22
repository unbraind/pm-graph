import { listAllComplete, readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import type { PmCompleteListCertificate } from "@unbrained/pm-cli/sdk";
import { minimalBlockerCuts } from "./blocker-cuts.ts";
import type { BlockerCutOptions, BlockerCutReceipt, BlockerCutRefusalCode } from "./blocker-cuts.ts";
import type { CommandContext, ExtensionApi, Graph } from "./index.ts";

/** Structured CLI refusal; the host honors exit_code while retaining the full result. */
export type BlockerCutCommandRefusal = {
  ok: false;
  exit_code: number;
  code: BlockerCutRefusalCode | "SOURCE_INCOMPLETE";
  remediation: string;
  refusal: { code: BlockerCutCommandRefusal["code"]; remedy: string };
  /** Declared row collection is present even when the host delivers a refusal. */
  cuts: [];
  receipt?: BlockerCutReceipt;
  source?: PmCompleteListCertificate;
};

/** Preserve refusal evidence in CLI JSON/TOON instead of losing it in error formatting. */
function commandRefusal(code: BlockerCutCommandRefusal["code"], remedy: string, receipt?: BlockerCutReceipt, source?: PmCompleteListCertificate): BlockerCutCommandRefusal {
  return { ok: false, code, remediation: remedy, refusal: { code, remedy }, cuts: [],
    exit_code: code === "UNKNOWN_GOAL" ? 3 : 2, receipt, source };
}

/** Register the offline command; source reads are strict, complete, and extension-free. */
export function registerBlockerCuts(
  api: ExtensionApi,
  resolveRoot: (context: CommandContext) => string,
  project: (items: Awaited<ReturnType<typeof listAllComplete>>["items"], root: string) => Graph,
): void {
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
      const options: BlockerCutOptions = {};
      const positionals: string[] = [];
      const flags = new Map<string, "maxStates" | "maxWork" | "maxCuts" | "maxSize">([
        ["--max-states", "maxStates"], ["--max-work", "maxWork"], ["--max-cuts", "maxCuts"], ["--max-size", "maxSize"],
      ]);
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--json") continue;
        const key = flags.get(arg);
        if (key) {
          const value = args[++i];
          if (!value || !/^\d+$/.test(value)) return commandRefusal("INVALID_OPTIONS", `Supply a positive integer after ${arg}.`);
          options[key] = Number(value);
        } else if (arg.startsWith("-")) {
          return commandRefusal("INVALID_OPTIONS", `Remove unsupported flag ${arg}; use blocker-cuts --help.`);
        } else positionals.push(arg);
      }
      if (positionals.length !== 1) return commandRefusal("INVALID_OPTIONS", "Use pm pm-graph blocker-cuts <exact-goal-id>; see --help for budgets.");
      let source: PmCompleteListCertificate;
      let snapshot: Awaited<ReturnType<typeof listAllComplete>>;
      let root: string;
      try {
        root = resolveRoot(context);
        snapshot = await listAllComplete({}, { pmRoot: root, noExtensions: true });
        source = snapshot.complete_list;
        const registry = resolveRuntimeStatusRegistry((await readSettings(root)).schema);
        options.resolvedStatuses = [...registry.terminal_statuses];
        options.unresolvedStatuses = [...registry.by_id.keys()].filter((status) => !registry.terminal_statuses.has(status));
      } catch (error: unknown) {
        const cause = error instanceof Error ? error.message : String(error);
        return commandRefusal("SOURCE_INCOMPLETE", `Restore a readable complete tracker; run pm list --all --full --strict-read --output-limit unbounded --output-budget unbounded, then retry. Cause: ${cause}`);
      }
      const graph = project(snapshot.items, root);
      const result = minimalBlockerCuts(graph, positionals[0], options);
      if (!result.ok) return { ...commandRefusal(result.refusal.code, result.refusal.remedy, result.receipt, source), goal: result.goal };
      return { ...result, source };
    },
  });
}
