/**
 * Exercises the canonical merge-driver installer through a real Windows
 * command parser.
 *
 * The vendored installer this test used to cover was replaced by the thin
 * launcher over `pm-ops/merge-driver`, so the adversarial path property moves
 * with it: a `pm.cmd` shim in a directory whose name holds spaces and a literal
 * `%USERNAME%` must still be dispatched through cmd.exe without expansion or
 * splitting. Runs only on the Windows CI job.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runPrepareMergeDriver } from "pm-ops/merge-driver";

test("Windows dispatch survives spaces and literal percent-delimited path segments", (t) => {
  assert.strictEqual(process.platform, "win32");
  const directory = mkdtempSync(join(tmpdir(), "pm graph %USERNAME% "));
  const marker = join(directory, "installed.txt");
  writeFileSync(join(directory, "pm.cmd"), '@echo off\r\n> "%PM_GRAPH_TEST_MARKER%" echo %*\r\n');
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const environment = { ...process.env, PATH: directory, PM_GRAPH_TEST_MARKER: marker };
  assert.strictEqual(runPrepareMergeDriver(environment, "win32"), 0);
  assert.strictEqual(readFileSync(marker, "utf8").trim(), "merge install");
});
