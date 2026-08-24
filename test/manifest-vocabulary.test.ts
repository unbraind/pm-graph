import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { checkExtensionManifestCompatibility } from "@unbrained/pm-cli/sdk";

const repoRoot = resolve(import.meta.dirname, "..");

const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
) as { devDependencies?: Record<string, string> };
const extensionManifest = JSON.parse(
  readFileSync(resolve(repoRoot, "manifest.json"), "utf8"),
) as Record<string, unknown>;

/**
 * The pm CLI reads only the keys of its closed extension-manifest vocabulary
 * (`name`, `version`, `entry`, `priority`, `description`, `author`,
 * `capabilities`, `manifest_version`, `pm_min_version`, `pm_max_version`,
 * `engines`, `trusted`, `provenance`, `sandbox_profile`, `permissions`,
 * `activation`, `contributions`, `legacy_capability_aliases`) and ignores every
 * other key. Since CLI 2026.8.19 an out-of-vocabulary key also surfaces as a
 * `manifest_unknown_key` warning finding — which is exactly what made this
 * package's inert `pm: {"compatibility": "v2"}` blob visible in `pm health`
 * output and in strict CI assertions downstream (see unbraind/pm-linear PRs
 * #75/#76, whose smoke suite asserts exact finding codes).
 *
 * This check runs the SDK's own manifest gate against the bytes on disk, so any
 * key the running CLI does not recognize fails here instead of shipping as a
 * silent warning.
 */
test("the extension manifest uses only keys the pm CLI recognizes", () => {
  const pin = packageJson.devDependencies?.["@unbrained/pm-cli"] ?? "";
  assert.match(pin, /^\d+\.\d+\.\d+$/, "the pinned CLI version must be an exact three-part version");
  const result = checkExtensionManifestCompatibility(extensionManifest, { pmVersion: pin });
  const unknownKeyFindings = result.findings.filter((finding) => finding.code === "manifest_unknown_key");
  assert.deepStrictEqual(
    unknownKeyFindings,
    [],
    `manifest.json carries keys outside the closed manifest vocabulary: ${unknownKeyFindings.map((f) => f.path).join(", ")}`,
  );
});
