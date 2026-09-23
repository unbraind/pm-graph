/** Tests the thin `prepare` launcher over the canonical `pm-ops/merge-driver`. */
import assert from "node:assert/strict";
import test from "node:test";

// Importing the launcher executes it (it is the prepare hook). Absent `pm` is a supported
// 0-exit state and a clean `pm merge install` is 0, so only a broken CLI fails this.
import "../scripts/prepare-merge-driver.ts";

test("the prepare launcher delegates to the canonical pm-ops merge-driver export", () => {
  assert.strictEqual(process.exitCode, 0);
});