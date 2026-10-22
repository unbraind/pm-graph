import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { PmClient, listAllComplete } from "@unbrained/pm-cli/sdk";
import { graphFromItems } from "../src/index.ts";
import type { Graph } from "../src/index.ts";
import type { SnapshotImpactResult } from "../src/snapshot-impact.ts";
import { collectHandlers } from "./helpers.ts";

const root = resolve(import.meta.dirname, "..");
const host = JSON.parse(readFileSync(join(root, "node_modules/@unbrained/pm-cli/package.json"), "utf8")) as { bin: { pm: string } };
const cli = join(root, "node_modules/@unbrained/pm-cli", host.bin.pm);

test("documented CLI exports compare real SDK snapshots in a non-git tracker with no git on PATH", async () => {
  const ws = mkdtempSync(join(tmpdir(), "pmg-snapshot-no-git-"));
  try {
    const bin = join(ws, "bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, process.platform === "win32" ? "node.exe" : "node"));
    const env = { ...process.env, HOME: join(ws, "isolated-home"), PATH: bin, GIT_CEILING_DIRECTORIES: dirname(ws), PM_AUTHOR: "snapshot-test", PM_PATH: join(ws, ".agents/pm") };
    const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: ws, env, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const example = readFileSync(join(root, "docs/snapshot-impact-example.md"), "utf8");
    const exports = [...example.matchAll(/^pm (.+) > (before|after)\.json$/gm)];
    assert.equal(exports.length, 2, "document both snapshot exports");
    /** Execute the documented export and verify every projected row before saving it. */
    const exportSnapshot = (side: "before" | "after", items: Parameters<typeof graphFromItems>[0]): void => {
      const args = exports.find((match) => match[2] === side)![1].split(/\s+/);
      const result = run(args);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const value = JSON.parse(result.stdout) as { graph: Graph };
      assert.ok(Array.isArray(value.graph.relationships), "documented exports must contain Graph relationships");
      const expected = graphFromItems(items, ".", new Map());
      assert.deepEqual(value.graph.nodes.map((node) => node.id).sort(), expected.nodes.map((node) => node.id).sort());
      assert.deepEqual(value.graph.relationships.map((edge) => JSON.stringify(edge)).sort(), expected.relationships.map((edge) => JSON.stringify(edge)).sort());
      for (const flag of ["--output-limit", "--output-budget"]) {
        assert.equal(args[args.indexOf(flag) + 1], "unbounded", `${side} export must explicitly disable ${flag}`);
      }
      writeFileSync(join(ws, `${side}.json`), result.stdout);
    };
    const initialized = run(["init", "--defaults", "--agent-guidance", "skip", "--prefix", "snap"]);
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    const extensionRoot = join(ws, ".agents/pm/extensions/pm-graph");
    mkdirSync(extensionRoot, { recursive: true });
    for (const name of ["dist", "manifest.json", "package.json"]) cpSync(join(root, name), join(extensionRoot, name), { recursive: true });
    symlinkSync(join(root, "node_modules"), join(extensionRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const client = new PmClient({ pmRoot: join(ws, ".agents/pm"), author: "snapshot-test", noExtensions: true });
    const first = await client.create({ type: "Task", title: "Goal", createMode: "progressive" });
    const second = await client.create({ type: "Task", title: "Old blocker", createMode: "progressive" });
    await client.update(first.item.id, { blockedBy: second.item.id });
    const before = await listAllComplete({}, { pmRoot: join(ws, ".agents/pm"), noExtensions: true });
    assert.equal(before.complete_list.source_complete, true);
    assert.equal(before.items.length, 2);
    exportSnapshot("before", before.items);
    await client.update(second.item.id, { status: "closed", closeReason: "Synthetic completion" });
    const after = await listAllComplete({}, { pmRoot: join(ws, ".agents/pm"), noExtensions: true });
    exportSnapshot("after", after.items);
    const args = ["pm-graph", "snapshot-impact", "before.json", "after.json", first.item.id];
    const json = run([...args, "--json", "--output-limit", "unbounded", "--output-budget", "unbounded"]);
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const result = JSON.parse(json.stdout) as Extract<SnapshotImpactResult, { ok: true }>;
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.receipt.output.total, 2);
    assert.equal(result.changes[0].kind, "blocker-cut-removed");
    assert.equal(result.changes[1].kind, "blocker-cut-added");
    const toon = run(args);
    assert.equal(toon.status, 0, toon.stderr || toon.stdout);
    assert.match(toon.stdout, /blocker-cut-removed/);
    const bounded = run([...args, "--limit", "1", "--json"]);
    const page = JSON.parse(bounded.stdout) as Extract<SnapshotImpactResult, { ok: true }>;
    assert.equal(page.receipt.output.omitted, 1);
    assert.equal(page.receipt.output.nextOffset, 1);
    const recovered = run([...args, "--limit", "1", "--offset", "1", "--json"]);
    assert.equal(JSON.parse(recovered.stdout).changes[0].kind, "blocker-cut-added");
    const hostBounded = run([...args, "--output-budget", "1", "--json"]);
    assert.equal(hostBounded.status, 2, hostBounded.stderr || hostBounded.stdout);
    assert.ok(JSON.parse(hostBounded.stdout).output_budget_exceeded);
    const projected = run([...args, "--output-include", "changes.kind", "--json"]);
    assert.ok(JSON.parse(projected.stdout).read_output);
    const missing = run(["pm-graph", "snapshot-impact", "missing.json", "after.json", first.item.id, "--json"]);
    assert.equal(missing.status, 2, missing.stderr || missing.stdout);
    assert.equal(JSON.parse(missing.stdout).refusal.code, "INPUT_READ");
    const unknown = run(["pm-graph", "snapshot-impact", "before.json", "after.json", "absent", "--json"]);
    assert.equal(unknown.status, 3, unknown.stderr || unknown.stdout);
    assert.equal(JSON.parse(unknown.stdout).refusal.code, "UNKNOWN_GOAL");
    const help = run(["pm-graph", "snapshot-impact", "--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /snapshot-impact/);
    const noChange = run(["pm-graph", "snapshot-impact", "before.json", "before.json", first.item.id, "--json"]);
    assert.equal(JSON.parse(noChange.stdout).changed, false);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("command refuses malformed files and flags without consulting a live tracker", async () => {
  const ws = mkdtempSync(join(tmpdir(), "pmg-snapshot-input-"));
  const command = collectHandlers().get("pm-graph snapshot-impact")!;
  try {
    const graph = { nodes: [{ id: "goal", labels: ["PmItem"], properties: { status: "ready" } }], relationships: [] };
    writeFileSync(join(ws, "graph.json"), JSON.stringify(graph));
    writeFileSync(join(ws, "bad.json"), "{");
    writeFileSync(join(ws, "large.json"), "");
    truncateSync(join(ws, "large.json"), 16 * 1024 * 1024 + 1);
    const cases: Array<[string[], string]> = [
      [[], "INVALID_OPTIONS"], [["--unknown"], "INVALID_OPTIONS"], [["--limit"], "INVALID_OPTIONS"], [["--offset", "-1"], "INVALID_OPTIONS"],
      [["--resolved-statuses", ""], "INVALID_OPTIONS"], [["--resolved-statuses", "done,"], "INVALID_OPTIONS"], [["--unresolved-statuses", "--json"], "INVALID_OPTIONS"],
      [["bad.json", "graph.json", "goal"], "INPUT_JSON"], [["missing.json", "graph.json", "goal"], "INPUT_READ"],
      [["graph.json", "missing.json", "goal"], "INPUT_READ"], [[".", "graph.json", "goal"], "INPUT_READ"], [["large.json", "graph.json", "goal"], "INPUT_LIMIT"],
      [["graph.json", "graph.json", "goal", "--limit", "0"], "INVALID_OPTIONS"],
    ];
    for (const [args, code] of cases) {
      const result = await command({ cwd: ws, args }) as SnapshotImpactResult;
      assert.equal(result.ok, false, JSON.stringify({ args, result }));
      if (!result.ok) assert.equal(result.refusal.code, code);
    }
    const valid = await command({ cwd: ws, args: ["graph.json", "graph.json", "goal", "--resolved-statuses", "done", "--unresolved-statuses", "ready", "--cut-max-cuts", "8", "--cut-max-size", "4", "--cut-max-states", "100", "--cut-max-work", "1000", "--max-work", "1000", "--json"] }) as SnapshotImpactResult;
    assert.equal(valid.ok, true, JSON.stringify(valid));
    const help = await command({ args: ["-h"] }) as { usage: string };
    assert.match(help.usage, /--offset/);
    // Default cwd and args are exercised without writing to the package tracker.
    assert.equal((await command({}) as SnapshotImpactResult).ok, false);
    const absolute = await command({ args: [join(ws, "graph.json"), join(ws, "graph.json"), "goal", "--unresolved-statuses", "ready"] }) as SnapshotImpactResult;
    assert.equal(absolute.ok, true);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
