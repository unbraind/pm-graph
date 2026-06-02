import type { Exporter } from "@unbrained/pm-cli/sdk";
type CommandContext = {
    command?: string;
    args?: string[];
    cwd?: string;
    workspaceRoot?: string;
};
type RegisterCommand = {
    name: string;
    description: string;
    run: (context: CommandContext) => Promise<unknown>;
};
type ExtensionApi = {
    registerCommand(command: RegisterCommand): void;
    registerExporter(name: string, exporter: Exporter): void;
};
export type ExportFormat = "cypher" | "mermaid" | "dot" | "json";
export type EdgeFilter = "deps" | "tags" | "all";
export declare function activate(api: ExtensionApi): void;
declare const _default: {
    activate: typeof activate;
};
export default _default;
