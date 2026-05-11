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
};
export declare function activate(api: ExtensionApi): void;
declare const _default: {
    activate: typeof activate;
};
export default _default;
