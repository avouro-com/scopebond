// A gzip-compressed tar of a few flat files, the format the engine bundle is published in. Written and read here with Node's
// zlib alone (no tar program, no dependency): ustar headers, regular files only, names without folders. Reading refuses
// anything else (a folder, a link, a path, a name twice, a size over the limit), so unpacking can never write outside the
// folder it is given.

import { gunzipSync, gzipSync } from "node:zlib";

export interface TgzFile { name: string; bytes: Buffer }

const BLOCK = 512;
/** A file name the bundle may carry: no folder, no leading dot. */
export const FLAT_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

function octal(value: number, width: number): Buffer {
  const text = value.toString(8).padStart(width - 1, "0");
  return Buffer.from(`${text}\0`, "ascii");
}

function header(name: string, size: number): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, "ascii");
  octal(0o644, 8).copy(h, 100);
  octal(0, 8).copy(h, 108);
  octal(0, 8).copy(h, 116);
  octal(size, 12).copy(h, 124);
  octal(0, 12).copy(h, 136);
  h.fill(0x20, 148, 156);
  h.write("0", 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of h) sum += byte;
  Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(h, 148);
  return h;
}

/** Pack `files` (flat names, in the order given) into a gzip-compressed tar. The same files give the same bytes. */
export function packTgz(files: readonly TgzFile[]): Buffer {
  const parts: Buffer[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!FLAT_NAME.test(file.name) || seen.has(file.name)) throw new Error(`not a flat, unique file name: ${file.name}`);
    seen.add(file.name);
    parts.push(header(file.name, file.bytes.length), file.bytes);
    const pad = (BLOCK - (file.bytes.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

const field = (h: Buffer, start: number, length: number): string => {
  const raw = h.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString("ascii");
};

/** The files of a gzip-compressed tar, or an Error saying why it is refused. At most `maxFiles` files and `maxBytes` bytes
 *  unpacked in all. */
export function unpackTgz(tgz: Buffer, limits: { maxFiles?: number; maxBytes?: number } = {}): TgzFile[] | Error {
  const maxFiles = limits.maxFiles ?? 16;
  const maxBytes = limits.maxBytes ?? 128 * 1024 * 1024;
  let tar: Buffer;
  try { tar = gunzipSync(tgz, { maxOutputLength: maxBytes + BLOCK * (2 * maxFiles + 4) }); } catch { return new Error("not a gzip file, or larger than allowed"); }
  const files: TgzFile[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let total = 0;
  while (offset + BLOCK <= tar.length) {
    const h = tar.subarray(offset, offset + BLOCK);
    if (h.every((b) => b === 0)) return files;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (Number.parseInt(field(h, 148, 8).trim(), 8) !== sum) return new Error("a tar header's checksum is wrong");
    const name = field(h, 0, 100);
    const type = field(h, 156, 1);
    const prefix = field(h, 345, 155);
    if (prefix || !FLAT_NAME.test(name)) return new Error(`a file in a folder or with an unusual name: ${name.slice(0, 60)}`);
    if (type !== "0" && type !== "") return new Error(`not a regular file: ${name}`);
    if (seen.has(name)) return new Error(`a file is there twice: ${name}`);
    seen.add(name);
    const size = Number.parseInt(field(h, 124, 12).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) return new Error(`a file's size cannot be read: ${name}`);
    total += size;
    if (files.length >= maxFiles || total > maxBytes) return new Error("more files or bytes than allowed");
    const start = offset + BLOCK;
    if (start + size > tar.length) return new Error(`the tar ends inside ${name}`);
    files.push({ name, bytes: Buffer.from(tar.subarray(start, start + size)) });
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return new Error("the tar has no end marker");
}
