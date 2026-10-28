import type { CommandContext, ExtensionApi } from "./index.ts";
/** Register a certified offline read; host JSON/TOON output controls preserve explicit row omissions. */
export declare function registerEvidencePath(api: ExtensionApi, resolveRoot: (context: CommandContext) => string): void;
