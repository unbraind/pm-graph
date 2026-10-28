import type { ProjectionSink } from "./event-projection.ts";
import type { CommandContext, ExtensionApi } from "./index.ts";
/** Register bounded JSON/TOON refresh receipts without embedding the full persisted graph. */
export declare function registerEventProjection(api: ExtensionApi, resolveRoot: (context: CommandContext) => string, neo4j: ProjectionSink): void;
