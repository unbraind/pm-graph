/** Tests the TypeScript-only, fail-loud merge-driver lifecycle. */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  installMergeDrivers,
  resolvePmCommand,
  runScriptEntry,
} from "../scripts/prepare-merge-driver.ts";

/** Direct-entry path used without creating a subprocess. */
const SCRIPT_PATH = realpathSync(
  fileURLToPath(new URL("../scripts/prepare-merge-driver.ts", import.meta.url)),
);

test("POSIX resolver preserves shell PATH semantics and filesystem checks", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pm-graph-prepare-"));
  const executable = join(directory, "pm");
  writeFileSync(executable, "#!/bin/sh\n");
  chmodSync(executable, 0o755);
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  assert.strictEqual(resolvePmCommand(`/missing:${directory}`, "", "linux"), executable);
  assert.strictEqual(resolvePmCommand(`${directory}:`, "", "linux"), executable);
});

test("POSIX resolver rejects missing, non-executable, and directory candidates", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pm-graph-reject-"));
  const fileDirectory = join(root, "file");
  const directoryDirectory = join(root, "directory");
  mkdirSync(fileDirectory);
  mkdirSync(directoryDirectory);
  writeFileSync(join(fileDirectory, "pm"), "not executable");
  mkdirSync(join(directoryDirectory, "pm"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.strictEqual(
    resolvePmCommand(`${join(root, "missing")}:${fileDirectory}:${directoryDirectory}`, "", "linux"),
    undefined,
  );
});

test("Windows resolver handles quoted PATH entries and normalized extensions", () => {
  const inspected: Array<[string, NodeJS.Platform]> = [];
  const command = resolvePmCommand(
    '"C:\\Program Files\\pm";C:\\fallback;',
    " EXE ;.CMD",
    "win32",
    (candidate, platform) => {
      inspected.push([candidate, platform]);
      return candidate === "C:\\Program Files\\pm\\pm.CMD";
    },
  );

  assert.strictEqual(command, "C:\\Program Files\\pm\\pm.CMD");
  assert.deepStrictEqual(inspected, [
    ["C:\\Program Files\\pm\\pm.EXE", "win32"],
    ["C:\\Program Files\\pm\\pm.CMD", "win32"],
  ]);
});

test("Windows resolver uses PATHEXT defaults and ignores empty PATH entries", () => {
  const inspected: string[] = [];
  assert.strictEqual(resolvePmCommand(
    ";C:\\bin;",
    "",
    "win32",
    (candidate) => {
      inspected.push(candidate);
      return false;
    },
  ), undefined);
  assert.deepStrictEqual(inspected, [
    "C:\\bin\\pm.COM",
    "C:\\bin\\pm.EXE",
    "C:\\bin\\pm.BAT",
    "C:\\bin\\pm.CMD",
  ]);
});

test("Windows resolver verifies real and missing command shims", (t) => {
  const directory = `pm-graph-windows-${process.pid}-${Date.now()}`;
  const candidate = win32.join(directory, "pm.CMD");
  writeFileSync(candidate, "");
  t.after(() => rmSync(candidate, { force: true }));

  assert.strictEqual(resolvePmCommand(directory, ".CMD", "win32"), candidate);
  assert.strictEqual(resolvePmCommand(`${directory}-missing`, ".CMD", "win32"), undefined);
});

test("resolver reads process defaults and tolerates a missing PATH", (t) => {
  const pathValue = process.env.PATH;
  delete process.env.PATH;
  t.after(() => {
    if (pathValue === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = pathValue;
    }
  });

  assert.strictEqual(resolvePmCommand(undefined, undefined, "linux", () => false), undefined);
});

test("installer executes the resolved POSIX command without a shell", () => {
  const calls: unknown[][] = [];
  const code = installMergeDrivers((...args) => {
    calls.push(args);
    return { status: 0 };
  }, "linux", () => "/opt/pm/bin/pm");

  assert.strictEqual(code, 0);
  assert.deepStrictEqual(calls, [[
    "/opt/pm/bin/pm",
    ["merge", "install"],
    { shell: false, stdio: "inherit" },
  ]]);
});

test("installer protects Windows shim paths from cmd expansion", () => {
  const calls: unknown[][] = [];
  const code = installMergeDrivers((...args) => {
    calls.push(args);
    return { status: 0 };
  }, "win32", () => "C:\\Program Files\\npm-%USERNAME%\\pm.CMD");

  assert.strictEqual(code, 0);
  assert.deepStrictEqual(calls, [[
    "cmd.exe",
    ["/d", "/v:off", "/s", "/c", '""%PM_GRAPH_PM_SHIM%" merge install"'],
    {
      env: { ...process.env, PM_GRAPH_PM_SHIM: "C:\\Program Files\\npm-%USERNAME%\\pm.CMD" },
      shell: false,
      stdio: "inherit",
      windowsVerbatimArguments: true,
    },
  ]]);
});

test("installer distinguishes absence and execution failures", () => {
  let ran = false;
  assert.strictEqual(installMergeDrivers(() => {
    ran = true;
    return { status: 0 };
  }, "linux", () => undefined), 0);
  assert.strictEqual(ran, false);

  const error = new Error("broken executable");
  assert.throws(
    () => installMergeDrivers(() => ({ error, status: null }), "linux", () => "/bin/pm"),
    error,
  );
  assert.strictEqual(
    installMergeDrivers(() => ({ status: 17 }), "linux", () => "/bin/pm"),
    17,
  );
  assert.strictEqual(
    installMergeDrivers(() => ({ status: null }), "linux", () => "/bin/pm"),
    1,
  );
});

test("entry guard declines imports and runs the main script", () => {
  assert.strictEqual(runScriptEntry(["node"]), undefined);
  assert.strictEqual(runScriptEntry(["node", import.meta.dirname]), undefined);
  assert.strictEqual(
    runScriptEntry(["node", SCRIPT_PATH], () => ({ status: 0 })),
    0,
  );
});
