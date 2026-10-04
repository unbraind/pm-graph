/** Exercises the shared CI installer against real Git state and a controlled package installer. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

const installer = join(process.cwd(), "scripts/install-pm-github.sh");
const registry = ".agents/pm/extensions/.managed-extensions.json";
const managed = JSON.parse(readFileSync(registry, "utf8")) as { entries: { name: string; source: { input: string } }[] };
const expectedSource = managed.entries.find((entry) => entry.name === "pm-github")!.source.input;
const expectedVersion = expectedSource.slice("npm:pm-github@".length);

/** Builds a fixture that records argv and mutates only its own registry and package metadata. */
function fixture(t: TestContext, tracked: boolean): string {
  const directory = mkdtempSync(join(tmpdir(), "graph-github-install-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "node_modules/.bin"), { recursive: true });
  mkdirSync(join(directory, ".agents/pm/extensions"), { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: directory }).status, 0);
  if (tracked) {
    writeFileSync(join(directory, registry), "original registry\n");
    assert.equal(spawnSync("git", ["add", registry], { cwd: directory }).status, 0);
  }
  const fakePm = join(directory, "node_modules/.bin/pm");
  writeFileSync(fakePm, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > installer-argv.txt
if [ "\${FIXTURE_INSTALL_FAIL:-0}" != 0 ]; then exit "$FIXTURE_INSTALL_FAIL"; fi
mkdir -p .agents/pm/extensions/pm-github
printf '{"version":"%s"}\\n' "$FIXTURE_INSTALLED_VERSION" > .agents/pm/extensions/pm-github/package.json
printf 'installer registry\\n' > .agents/pm/extensions/.managed-extensions.json
`);
  chmodSync(fakePm, 0o755);
  return directory;
}

/** Runs the actual shared installer while controlling only the fixture dependency's response. */
function install(directory: string, version = expectedVersion, fail = "0") {
  return spawnSync("bash", [installer], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, FIXTURE_INSTALLED_VERSION: version, FIXTURE_INSTALL_FAIL: fail },
  });
}

test("both Ubuntu workflows use the one tested extension installer", () => {
  for (const path of [".github/workflows/ci.yml", ".github/workflows/pm-github-sync.yml"]) {
    const workflow = readFileSync(path, "utf8");
    assert.match(workflow, /run: bash scripts\/install-pm-github\.sh/);
    assert.doesNotMatch(workflow, /pm package install npm:pm-github@/);
  }
});

test("the pinned install restores a tracked registry byte for byte", (t) => {
  const directory = fixture(t, true);
  const result = install(directory);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(directory, "installer-argv.txt"), "utf8"), `package\ninstall\n${expectedSource}\n--project\n`);
  assert.equal(readFileSync(join(directory, registry), "utf8"), "original registry\n");
});

test("the installer removes its transient untracked registry", (t) => {
  const directory = fixture(t, false);
  assert.equal(install(directory).status, 0);
  assert.throws(() => readFileSync(join(directory, registry)), { code: "ENOENT" });
});

test("a mismatched installed version fails before restoring the registry", (t) => {
  const directory = fixture(t, true);
  assert.equal(install(directory, "0.0.0").status, 1);
  assert.equal(readFileSync(join(directory, registry), "utf8"), "installer registry\n");
});

test("installer failure propagates without a package version probe", (t) => {
  const directory = fixture(t, false);
  assert.equal(install(directory, expectedVersion, "9").status, 9);
  assert.throws(() => readFileSync(join(directory, "./.agents/pm/extensions/pm-github/package.json")), { code: "ENOENT" });
});
