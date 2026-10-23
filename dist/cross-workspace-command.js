import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { projectWorkspaces, projectionRefusal } from "./cross-workspace.js";
/** Parse an explicit bounded regular manifest without discovering workspaces, git, extensions or credentials. */
async function readManifest(file) {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
        if (!(await handle.stat()).isFile())
            return null;
        const buffer = Buffer.alloc(1024 * 1024 + 1);
        let length = 0;
        while (length < buffer.length) {
            const read = await handle.read(buffer, length, buffer.length - length, null);
            if (read.bytesRead === 0)
                break;
            length += read.bytesRead;
        }
        return length === buffer.length ? null : JSON.parse(buffer.subarray(0, length).toString("utf8"));
    }
    finally {
        await handle.close();
    }
}
/** Validate transport input before constructing private directory reader capabilities. */
function manifestScopes(value, base) {
    if (value === null || typeof value !== "object" || !("scopes" in value) || !Array.isArray(value.scopes)
        || !("consent" in value) || !Array.isArray(value.consent) || !value.consent.every((key) => typeof key === "string"))
        return null;
    const scopes = [];
    for (const scope of value.scopes) {
        if (scope === null || typeof scope !== "object" || !("key" in scope) || typeof scope.key !== "string"
            || !("pmRoot" in scope) || typeof scope.pmRoot !== "string" || scope.pmRoot.length === 0)
            return null;
        scopes.push({ key: scope.key, source: { kind: "directory", pmRoot: path.resolve(base, scope.pmRoot) } });
    }
    const evidence = "evidence" in value ? value.evidence : [];
    if (!Array.isArray(evidence))
        return null;
    // The SDK validates every evidence field before any source capability runs.
    return { scopes, consent: value.consent, evidence: evidence };
}
/** Register a read-only directory transport; database consumers bind core-authorized SDK readers directly. */
export function registerCrossWorkspace(api) {
    api.registerCommand({
        name: "pm-graph project",
        description: "Project explicitly consented workspaces into a qualified read-only graph with opaque boundary receipts.",
        arguments: [{ name: "manifest", required: true, description: "Explicit consent manifest JSON" }],
        read_output: { row_keys: ["rows", "boundaries"] },
        examples: ["pm pm-graph project projection.json --limit 100 --json"],
        failure_hints: ["Grant consent only to intended scopes; recover omitted rows with --offset; see boundary remedies for incomplete sources."],
        run: async (context) => {
            const args = context.args ?? [];
            if (args.includes("--help") || args.includes("-h"))
                return {
                    rows: [], boundaries: [], usage: "pm pm-graph project <manifest.json> [--limit 100] [--offset 0] [--json]",
                    manifest: { scopes: [{ key: "public", pmRoot: "tracker/.agents/pm" }], consent: ["public"], evidence: [] },
                    semantics: "Paths are relative to the manifest. Explicit local consent plus OS/SDK read permissions; hosted callers must bind their current authorization via projectWorkspaces. No traversal of denied scopes. Item nodes and local relationships only; cross-workspace SUPPORTS/EVIDENCE_FOR requires per-edge consent. Read sequentially, not a global atomic snapshot.",
                };
            let manifest;
            let limit = 100;
            let offset = 0;
            for (let index = 0; index < args.length; index++) {
                const arg = args[index];
                if (arg === "--json")
                    continue;
                if (arg === "--limit" || arg === "--offset") {
                    const raw = args[++index];
                    if (!raw || !/^\d+$/.test(raw))
                        return projectionRefusal();
                    if (arg === "--limit")
                        limit = Number(raw);
                    else
                        offset = Number(raw);
                }
                else if (arg.startsWith("-") || manifest !== undefined)
                    return projectionRefusal();
                else
                    manifest = arg;
            }
            if (manifest === undefined)
                return projectionRefusal();
            const file = path.resolve(context.cwd ?? process.cwd(), manifest);
            try {
                const parsed = manifestScopes(await readManifest(file), path.dirname(file));
                if (!parsed)
                    return projectionRefusal();
                return await projectWorkspaces(parsed.scopes, { consent: parsed.consent, evidence: parsed.evidence, authorize: () => true, limit, offset });
            }
            catch {
                return projectionRefusal();
            }
        },
    });
}
//# sourceMappingURL=cross-workspace-command.js.map