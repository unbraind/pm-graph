/** Deterministic real-tracker coverage for aggregate evidence-path validation. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { validateEvidencePaths } from "../scripts/validate-evidence-path.ts";
import { fingerprint } from "../scripts/tracker-fingerprint.ts";

test("aggregate validator counts a cheaper longer witness in a deterministic no-git tracker", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pmg-validator-"));
  const previousPath = process.env.PATH;
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  try {
    const emptyBin = join(workspace, "empty-bin");
    mkdirSync(emptyBin);
    process.env.PATH = emptyBin;
    process.env.GIT_CEILING_DIRECTORIES = dirname(workspace);
    const pmRoot = join(workspace, ".agents", "pm");
    const client = new PmClient({ pmRoot, noExtensions: true, author: "validator-test" });
    await client.init("witness", { defaults: true, mergeFence: false, agentGuidance: "skip" });
    for (const suffix of ["a", "b", "c", "d", "z"]) {
      await client.create({ id: `witness-${suffix}`, type: "Task", title: `Synthetic ${suffix}`,
        createMode: "progressive", unset: ["parent", "blocked_by"], clearDeps: true });
    }
    // Sorted IDs get costs 0, 940, 883, 826, 769. From c to z, c-a-d-z
    // costs 2478 while the shorter c-b-z costs 2592. No random state is used.
    for (const [from, targets] of [["c", ["a", "b"]], ["a", ["d"]], ["b", ["z"]], ["d", ["z"]]] as const) {
      await client.update(`witness-${from}`, {
        dep: targets.map((to) => `id=witness-${to},kind=related_to`), replaceDeps: true,
      });
    }
    const before = fingerprint(pmRoot);
    const report = await validateEvidencePaths(pmRoot);
    assert.equal(report.sourceComplete, true);
    assert.equal(report.sourceItems, 5);
    assert.equal(report.nodes, 5);
    assert.equal(report.edges, 5);
    assert.equal(report.questions, 25);
    assert.equal(report.reachable, 13);
    assert.equal(report.proved, 13);
    assert.equal(report.cheaperWitnesses, 1);
    assert.equal(report.longerCheaperWitnesses, 1);
    assert.equal(report.unknownCostReceipts, 13);
    assert.ok(Number(report.limitedSearchReceipts) > 0);
    assert.equal(report.inputUnchanged, true);
    assert.equal(fingerprint(pmRoot), before);
    assert.ok(!JSON.stringify(report).includes(pmRoot));
    assert.ok(!JSON.stringify(report).includes("witness-"));
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    rmSync(workspace, { recursive: true, force: true });
  }
});
