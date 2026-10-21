// The engine bundle's archive format (tgz.ts): what packTgz writes, a standard tar reads; what unpackTgz reads is only
// flat regular files within the limits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { packTgz, unpackTgz } from "../dist/index.js";

const files = [{ name: "scopebond-hook.cjs", bytes: Buffer.from("module.exports.run = () => {};\n") }, { name: "LICENSE", bytes: Buffer.alloc(1300, 0x41) }, { name: "empty", bytes: Buffer.alloc(0) }];

test("what packTgz writes, unpackTgz reads back exactly, and the same files give the same bytes", () => {
  const tgz = packTgz(files);
  assert.deepEqual(unpackTgz(tgz), files);
  assert.deepEqual(packTgz(files), tgz);
});

test("a standard tar program reads the archive", { skip: process.platform === "win32" && !process.env.SystemRoot }, () => {
  const tar = process.platform === "win32" ? join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
  const dir = mkdtempSync(join(tmpdir(), "sb-tgz-"));
  writeFileSync(join(dir, "a.tgz"), packTgz(files));
  const listed = spawnSync(tar, ["-tzf", "a.tgz"], { cwd: dir, encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split(/\r?\n/), files.map((f) => f.name));
  assert.equal(spawnSync(tar, ["-xzf", "a.tgz"], { cwd: dir }).status, 0);
  assert.deepEqual(readFileSync(join(dir, "LICENSE")), files[1].bytes);
});

/** A tar with one header changed, gzipped again (the checksum recomputed unless asked not to). */
function edited(change, { fixChecksum = true } = {}) {
  const tar = gunzipSync(packTgz(files.slice(0, 1)));
  change(tar);
  if (fixChecksum) {
    tar.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += tar[i];
    Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(tar, 148);
  }
  return gzipSync(tar);
}

test("folders, links, paths, duplicates, bad checksums and anything over the limits are refused", () => {
  const refused = [
    ["a path", edited((t) => { t.fill(0, 0, 100); t.write("../evil.cjs", 0, "ascii"); })],
    ["a folder name", edited((t) => { t.fill(0, 0, 100); t.write("sub/file", 0, "ascii"); })],
    ["a prefix", edited((t) => { t.write("x", 345, "ascii"); })],
    ["a link", edited((t) => { t.write("2", 156, "ascii"); })],
    ["a folder entry", edited((t) => { t.write("5", 156, "ascii"); })],
    ["a bad checksum", edited((t) => { t.write("y", 0, "ascii"); }, { fixChecksum: false })],
    ["not gzip", Buffer.from("plain")],
    ["no end", gzipSync(gunzipSync(packTgz(files.slice(0, 1))).subarray(0, 1024))],
  ];
  for (const [name, tgz] of refused) assert.ok(unpackTgz(tgz) instanceof Error, name);
  const twice = gzipSync(Buffer.concat([gunzipSync(packTgz(files.slice(0, 1))).subarray(0, 1024), gunzipSync(packTgz(files.slice(0, 1)))]));
  assert.ok(unpackTgz(twice) instanceof Error, "a name twice");
  assert.ok(unpackTgz(packTgz(files), { maxFiles: 2 }) instanceof Error, "too many files");
  assert.ok(unpackTgz(packTgz(files), { maxBytes: 100 }) instanceof Error, "too many bytes");
  assert.throws(() => packTgz([{ name: "../x", bytes: Buffer.alloc(1) }]));
  assert.throws(() => packTgz([{ name: "a", bytes: Buffer.alloc(1) }, { name: "a", bytes: Buffer.alloc(1) }]));
});
