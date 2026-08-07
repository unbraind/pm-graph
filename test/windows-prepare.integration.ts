/** Exercises the production lifecycle through a real Windows command parser. */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installMergeDrivers } from "../scripts/prepare-merge-driver.ts";

test("Windows dispatch survives spaces and literal percent-delimited path segments", (t) => {
  assert.strictEqual(process.platform, "win32");
  const directory = mkdtempSync(join(tmpdir(), "pm graph %USERNAME% "));
  const shim = join(directory, "pm.cmd");
  const marker = join(directory, "installed.txt");
  const previousMarker = process.env.PM_GRAPH_TEST_MARKER;
  writeFileSync(shim, '@echo off\r\n> "%PM_GRAPH_TEST_MARKER%" echo installed\r\n');
  process.env.PM_GRAPH_TEST_MARKER = marker;
  t.after(() => {
    if (previousMarker === undefined) {
      delete process.env.PM_GRAPH_TEST_MARKER;
    } else {
      process.env.PM_GRAPH_TEST_MARKER = previousMarker;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  assert.strictEqual(installMergeDrivers(undefined, "win32", () => shim), 0);
  assert.strictEqual(readFileSync(marker, "utf8").trim(), "installed");
});
