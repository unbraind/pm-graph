/** Every validator uses one source identity, including schemas and every native document format. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { createWorkspaceSnapshot } from "@unbrained/pm-cli/sdk";
import { fingerprint } from "../scripts/tracker-fingerprint.ts";
import { fingerprint as eventFingerprint } from "../scripts/validate-event-projection.ts";
import { fingerprint as blockerFingerprint } from "../scripts/validate-blocker-cuts.ts";
import { fingerprint as crossFingerprint } from "../scripts/validate-cross-workspace.ts";
import { fixture, seed } from "./event-projection-helpers.ts";

test("all validation fingerprints include authoritative schemas, native formats, hidden paths and byte/filename changes", async () => {
  const f = fixture();
  try {
    await seed(f.client, "fingerprint");
    const { manifest } = await createWorkspaceSnapshot(f.pmRoot);
    for (const validator of [eventFingerprint, blockerFingerprint, crossFingerprint]) assert.equal(validator, fingerprint);
    const original = fingerprint(f.pmRoot);
    for (const file of manifest.files) {
      const input = join(f.pmRoot, file);
      const bytes = readFileSync(input);
      writeFileSync(input, Buffer.concat([bytes, Buffer.from("\r\n")]));
      assert.notEqual(fingerprint(f.pmRoot), original, `SDK authoritative snapshot input ${file} must be covered`);
      writeFileSync(input, bytes);
    }
    const schema = join(f.pmRoot, "schema/types.json");
    const saved = readFileSync(schema);
    writeFileSync(schema, Buffer.concat([saved, Buffer.from("\r\n ")]));
    assert.notEqual(fingerprint(f.pmRoot), original, "schema-only changes must invalidate source preservation");
    writeFileSync(schema, saved); assert.equal(fingerprint(f.pmRoot), original);
    for (const directory of ["runtime", "locks", "search", "extensions", ".cache"]) {
      const cache = join(f.pmRoot, directory, "generated.json"); mkdirSync(dirname(cache), { recursive: true });
      writeFileSync(cache, "derived"); assert.equal(fingerprint(f.pmRoot), original);
    }
    let state = 0x175003;
    const random = (): number => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
    for (let sequence = 0; sequence < 500; sequence++) {
      const folder = ["schema", "tasks", "custom-types", ".authoritative", "transactions"][random() % 5];
      const extension = ["json", "toon", "jsonl", "md", "yaml", "bin"][random() % 6];
      const file = join(f.pmRoot, folder, "runtime", `case-${sequence}.${extension}`);
      const before = fingerprint(f.pmRoot);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from([0, 255, random() % 256, 13, 10]));
      assert.notEqual(fingerprint(f.pmRoot), before, `seed 0x175003 sequence ${sequence} create`);
      const created = fingerprint(f.pmRoot);
      writeFileSync(file, Buffer.from([0, 255, random() % 256, 10, 13]));
      assert.notEqual(fingerprint(f.pmRoot), created, `sequence ${sequence} edit`);
      const edited = fingerprint(f.pmRoot);
      renameSync(file, `${file}.renamed`);
      assert.notEqual(fingerprint(f.pmRoot), edited, `sequence ${sequence} rename`);
      rmSync(`${file}.renamed`);
      assert.equal(fingerprint(f.pmRoot), before, `sequence ${sequence} remove`);
    }
  } finally { rmSync(f.ws, { recursive: true, force: true }); }
});

test("source identity fails closed on nonregular authoritative inputs", () => {
  const f = fixture();
  try {
    // Symlinks are neither authoritative regular files nor safe traversal roots.
    symlinkSync("settings.json", join(f.pmRoot, "linked-settings"));
    assert.throws(() => fingerprint(f.pmRoot), /regular file/);
  } finally { rmSync(f.ws, { recursive: true, force: true }); }
});
