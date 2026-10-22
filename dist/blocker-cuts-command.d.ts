import { listAllComplete } from "@unbrained/pm-cli/sdk";
import type { PmCompleteListCertificate } from "@unbrained/pm-cli/sdk";
import type { BlockerCutReceipt, BlockerCutRefusalCode } from "./blocker-cuts.ts";
import type { CommandContext, ExtensionApi, Graph } from "./index.ts";
/** Structured CLI refusal; the host honors exit_code while retaining the full result. */
export type BlockerCutCommandRefusal = {
    ok: false;
    exit_code: number;
    code: BlockerCutRefusalCode | "SOURCE_INCOMPLETE";
    remediation: string;
    refusal: {
        code: BlockerCutCommandRefusal["code"];
        remedy: string;
    };
    /** Declared row collection is present even when the host delivers a refusal. */
    cuts: [];
    receipt?: BlockerCutReceipt;
    source?: PmCompleteListCertificate;
};
/** Register the offline command; source reads are strict, complete, and extension-free. */
export declare function registerBlockerCuts(api: ExtensionApi, resolveRoot: (context: CommandContext) => string, project: (items: Awaited<ReturnType<typeof listAllComplete>>["items"], root: string) => Graph): void;
