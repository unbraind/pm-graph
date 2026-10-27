import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Hash every authoritative filename and byte, excluding only top-level SDK accelerators. */
export function fingerprint(root: string): string {
  const digest = createHash("sha256");
  const derived = new Set(["runtime", "locks", "search", "extensions", ".cache"]);
  const walk = (parts: string[]): void => {
    for (const entry of readdirSync(join(root, ...parts), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (parts.length === 0 && derived.has(entry.name)) continue;
      const next = [...parts, entry.name];
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) {
        const bytes = readFileSync(join(root, ...next));
        digest.update(JSON.stringify([next.join("/"), bytes.length])).update(bytes);
      } else throw new Error("Authoritative input must be a regular file or directory");
    }
  };
  walk([]);
  return digest.digest("hex");
}
