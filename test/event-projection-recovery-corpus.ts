/** Shared adversarial cases for SDK, real CLI and packed-host recovery acceptance. */
import assert from "node:assert/strict";
import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getHistoryPath } from "@unbrained/pm-cli/sdk";

/** Every JSON root kind, falsey payload, malformed value and whitespace variant remains foreign storage. */
export const FOREIGN_CHECKPOINTS = ["null", "false", "true", "0", "-0", "1", '""', '"checkpoint"', "[]", "[null,false,0]", "{}", '{"owner":"foreign"}', "\r\n null \r\n", "", "{", "undefined"];
/** Clear only synthetic tracker history streams; current authoritative items and configuration remain intact. */
export function clearProjectionHistory(pmRoot: string): void {
  const directory = dirname(getHistoryPath(pmRoot, "_workspace"));
  const streams = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  assert.ok(streams.length > 0, "the fixture must have native mutation history before resetting it");
  for (const stream of streams) writeFileSync(join(directory, stream.name), "");
}
