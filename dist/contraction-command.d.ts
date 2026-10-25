import type { CommandContext, ExtensionApi } from "./index.ts";
/** Register a certified, extension-free, read-only contraction over the source SDK view. */
export declare function registerContraction(api: ExtensionApi, resolveRoot: (context: CommandContext) => string): void;
