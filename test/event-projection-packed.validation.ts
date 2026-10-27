/** Manual packed acceptance across actual global, ephemeral and project package-manager hosts. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "graph-packed-"));
const sdkVersion = "2026.10.20";
const baseEnv = { ...process.env, NPM_CONFIG_USERCONFIG: "/dev/null", npm_config_userconfig: "/dev/null", PM_PATH: "", GIT_CEILING_DIRECTORIES: tmpdir() };
/** Run actual package managers and host executables, preserving bounded failure diagnostics. */
function run(bin: string, args: string[], cwd: string, extra: Record<string, string> = {}): string {
  const result = spawnSync(bin, args, { cwd, env: { ...baseEnv, ...extra }, encoding: "utf8", timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, `${bin} ${args[0]}: ${result.stderr || result.stdout || result.error}`);
  return result.stdout;
}
/** Exercise admission and sparse update through a real installed pm host and packed extension. */
function acceptance(name: string, bin: string, prefix: string[], extension: string, extra: Record<string, string> = {}): void {
  const ws = join(scratch, name); mkdirSync(ws);
  const invoke = (args: string[]): Record<string, unknown> => JSON.parse(run(bin, [...prefix, ...args, "--json"], ws, extra)) as Record<string, unknown>;
  invoke(["init", "--defaults", "--agent-guidance", "skip", "--prefix", "packed"]);
  const extensions = join(ws, ".agents/pm/extensions"); mkdirSync(extensions, { recursive: true });
  const installed = join(extensions, "pm-graph");
  cpSync(extension, installed, { recursive: true });
  const scope = join(installed, "node_modules/@unbrained"); mkdirSync(scope, { recursive: true });
  if (!existsSync(join(scope, "pm-cli"))) symlinkSync(join(dirname(extension), "@unbrained/pm-cli"), join(scope, "pm-cli"), "dir");
  const created = invoke(["create", "Task", "Packed source", "--create-mode", "progressive", "--unset", "parent", "--unset", "assignee", "--unset", "reviewer", "--unset", "sprint", "--unset", "release", "--unset", "blocked_by", "--unset", "blocked_reason", "--clear-deps"]);
  const id = String(created.id ?? (created.item as { id: string })?.id);
  const initial = invoke(["pm-graph", "refresh", "projection.json"]);
  assert.equal(initial.fullScans, 1);
  invoke(["update", id, "--title", "Packed update", "--unset", "parent", "--unset", "assignee", "--unset", "reviewer", "--unset", "sprint", "--unset", "release", "--unset", "blocked_by", "--unset", "blocked_reason", "--clear-deps"]);
  const sparse = invoke(["pm-graph", "refresh", "projection.json"]);
  assert.equal(sparse.itemReads, 1); assert.equal(sparse.fullScans, 0);
  console.log(JSON.stringify({ host: name, admission: true, sparseReads: 1, fullScans: 0 }));
}
try {
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", scratch], root);
  const archive = join(scratch, readdirSync(scratch).find((file) => file.endsWith(".tgz"))!);
  const npmPrefix = join(scratch, "npm-global-prefix");
  run("npm", ["install", "--global", "--prefix", npmPrefix, "--ignore-scripts", archive, `@unbrained/pm-cli@${sdkVersion}`], scratch);
  const npmExtension = join(npmPrefix, "lib/node_modules/pm-graph");
  acceptance("npm-global", join(npmPrefix, "bin/pm"), [], npmExtension);
  const bunRoot = join(scratch, "bun-global-root"); const bunBin = join(scratch, "bun-global-bin");
  const bunEnv = { BUN_INSTALL_GLOBAL_DIR: bunRoot, BUN_INSTALL_BIN: bunBin };
  run("bun", ["add", "--global", "--ignore-scripts", archive, `@unbrained/pm-cli@${sdkVersion}`], scratch, bunEnv);
  acceptance("bun-global", join(bunBin, "pm"), [], join(bunRoot, "node_modules/pm-graph"), bunEnv);
  acceptance("npx", "npx", ["--yes", "--package", `@unbrained/pm-cli@${sdkVersion}`, "pm"], npmExtension);
  acceptance("bunx", "bunx", ["--package", `@unbrained/pm-cli@${sdkVersion}`, "pm"], npmExtension);
  for (const manager of ["npm", "bun"]) {
    const project = join(scratch, `${manager}-project`); mkdirSync(project);
    writeFileSync(join(project, "package.json"), '{"name":"packed-acceptance","private":true}');
    run(manager, [manager === "npm" ? "install" : "add", "--ignore-scripts", archive, `@unbrained/pm-cli@${sdkVersion}`], project);
    acceptance(`${manager}-local`, join(project, "node_modules/.bin/pm"), [], join(project, "node_modules/pm-graph"));
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
