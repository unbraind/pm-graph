/**
 * Installs pm's field-aware Git merge drivers during package preparation.
 *
 * Consumer installs may omit development dependencies and therefore have no
 * `pm` executable. That absence is an intentional no-op. Once `pm` resolves,
 * however, a failed installation is surfaced instead of silently leaving the
 * clone without conflict-safe project-management history.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

/** Process fields needed to distinguish success, absence, and failure. */
interface CommandResult {
  readonly error?: Error;
  readonly status: number | null;
}

/** Injectable process boundary used by deterministic unit tests. */
type CommandRunner = (
  command: string,
  args: string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly shell: boolean;
    readonly stdio: "inherit";
    readonly windowsVerbatimArguments?: boolean;
  },
) => CommandResult;

/** Injectable filesystem boundary used while resolving a command candidate. */
type CandidateVerifier = (candidate: string, platform: NodeJS.Platform) => boolean;

/**
 * Determines whether a PATH candidate is executable on the selected platform.
 *
 * @param candidate - Candidate path produced from PATH and PATHEXT.
 * @param platform - Platform whose executable rules should be applied.
 * @returns Whether the candidate is a regular executable command file.
 */
function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) {
      return false;
    }
    if (platform === "win32") {
      return true;
    }
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the first executable `pm` command on PATH without executing it.
 *
 * Empty POSIX PATH entries mean the current directory. Windows ignores empty
 * entries, accepts quoted directories, and derives command suffixes from
 * PATHEXT. Looking up the command first preserves the important distinction
 * between an absent optional development dependency and a present broken CLI.
 *
 * @param pathValue - Platform-delimited PATH value.
 * @param pathExtValue - Windows PATHEXT value.
 * @param platform - Platform whose path rules should be used.
 * @param verifyCandidate - Filesystem boundary used to validate candidates.
 * @returns The first executable command path, or `undefined` when absent.
 */
export function resolvePmCommand(
  pathValue = process.env.PATH ?? "",
  pathExtValue = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
  platform: NodeJS.Platform = process.platform,
  verifyCandidate: CandidateVerifier = isExecutableFile,
): string | undefined {
  const windows = platform === "win32";
  const pathDelimiter = windows ? ";" : delimiter;
  const directories = pathValue
    .split(pathDelimiter)
    .map((directory) => windows
      && directory.length >= 2
      && directory.startsWith('"')
      && directory.endsWith('"')
      ? directory.slice(1, -1)
      : directory === "" && !windows ? "." : directory)
    .filter((directory) => directory.length > 0);
  const extensions = windows
    ? (pathExtValue || ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .map((extension) => extension.trim())
      .filter((extension) => extension.length > 0)
      .map((extension) => extension.startsWith(".") ? extension : `.${extension}`)
    : [""];

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = windows
        ? win32.join(directory, `pm${extension}`)
        : join(directory, "pm");
      if (verifyCandidate(candidate, platform)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Runs `pm merge install` and returns the lifecycle exit code.
 *
 * @param runner - Synchronous process boundary.
 * @param platform - Runtime platform used for command dispatch.
 * @param resolveCommand - PATH lookup boundary.
 * @returns Zero when pm is absent or succeeds; otherwise its failure status.
 */
export function installMergeDrivers(
  runner: CommandRunner = spawnSync,
  platform: NodeJS.Platform = process.platform,
  resolveCommand: () => string | undefined = resolvePmCommand,
): number {
  const executable = resolveCommand();
  if (!executable) {
    return 0;
  }
  const result = platform === "win32"
    ? runner(
      "cmd.exe",
      ["/d", "/v:off", "/s", "/c", '""%PM_GRAPH_PM_SHIM%" merge install"'],
      {
        env: { ...process.env, PM_GRAPH_PM_SHIM: executable },
        shell: false,
        stdio: "inherit",
        windowsVerbatimArguments: true,
      },
    )
    : runner(executable, ["merge", "install"], {
      shell: false,
      stdio: "inherit",
    });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

/**
 * Runs the lifecycle only when Node invoked this module as its main script.
 *
 * @param argv - Process arguments used to identify the entry module.
 * @param runner - Process boundary forwarded to the installer.
 * @returns Lifecycle exit code, or `undefined` when imported.
 */
export function runScriptEntry(
  argv: readonly string[] = process.argv,
  runner: CommandRunner = spawnSync,
): number | undefined {
  if (!argv[1]) {
    return undefined;
  }
  if (realpathSync(resolve(argv[1])) !== realpathSync(fileURLToPath(import.meta.url))) {
    return undefined;
  }
  return installMergeDrivers(runner);
}

process.exitCode = runScriptEntry() ?? process.exitCode;
