// The Scopebond program icon, drawn in code as the tray draws it (packages/tray/src/icon.rs: the navy tile with the cream
// "S", the "protected" state, no badge), so the repository holds no image file. The agent executable and the installer's
// entry in Settings -> Apps use it; the tray carries the same icon from its own build.
//
//   node icon.mjs [out.ico]   → build/scopebond.ico

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const NAVY = 0x1b3a5c;
const CREAM = 0xf7f4ee;

const rgb = (hex) => [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
const length = (x, y) => Math.sqrt(x * x + y * y);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const mod = (a, n) => ((a % n) + n) % n;

function roundedBox(u, v, cx, cy, half, radius) {
  const qx = Math.abs(u - cx) - (half - radius);
  const qy = Math.abs(v - cy) - (half - radius);
  return length(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** A stroke along an arc, with round ends; angles in degrees, clockwise from the right on screen. */
function arc(u, v, c, radius, start, sweep, width) {
  const angle = mod((Math.atan2(v - c[1], u - c[0]) * 180) / Math.PI, 360);
  if (mod(angle - start, 360) <= sweep) return Math.abs(length(u - c[0], v - c[1]) - radius) - width / 2;
  const end = (deg) => [c[0] + radius * Math.cos((deg * Math.PI) / 180), c[1] + radius * Math.sin((deg * Math.PI) / 180)];
  const [e1, e2] = [end(start), end(start + sweep)];
  return Math.min(length(u - e1[0], v - e1[1]), length(u - e2[0], v - e2[1])) - width / 2;
}

/** The icon, `size` pixels square, as straight RGBA bytes from the top row (the tray's IconState::Protected). */
export function render(size) {
  const scale = size / 32;
  const px = new Float64Array(size * size * 4);
  const paint = (color, distance) => {
    const [r, g, b] = rgb(color);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const a = clamp(0.5 - distance((x + 0.5) / scale, (y + 0.5) / scale) * scale, 0, 1);
        if (a <= 0) continue;
        const i = (y * size + x) * 4;
        px[i] = r * a + px[i] * (1 - a);
        px[i + 1] = g * a + px[i + 1] * (1 - a);
        px[i + 2] = b * a + px[i + 2] * (1 - a);
        px[i + 3] = a + px[i + 3] * (1 - a);
      }
    }
  };
  paint(NAVY, (u, v) => roundedBox(u, v, 16, 16, 15, 8));
  paint(CREAM, (u, v) => Math.min(arc(u, v, [15, 12.6], 3.4, 90, 230, 2.8), arc(u, v, [15, 19.4], 3.4, 270, 230, 2.8)));
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const a = px[i * 4 + 3];
    const un = (c) => (a > 0 ? clamp(c / a, 0, 1) : 0);
    out[i * 4] = Math.round(un(px[i * 4]) * 255);
    out[i * 4 + 1] = Math.round(un(px[i * 4 + 1]) * 255);
    out[i * 4 + 2] = Math.round(un(px[i * 4 + 2]) * 255);
    out[i * 4 + 3] = Math.round(a * 255);
  }
  return out;
}

/** One 32-bit icon image with alpha (a BITMAPINFOHEADER, the rows from the bottom in BGRA, an all-zero AND mask). */
function bmpEntry(rgba, size) {
  const maskRow = Math.ceil(size / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  const pixels = Buffer.alloc(size * size * 4);
  let o = 0;
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      pixels[o++] = rgba[i + 2]; pixels[o++] = rgba[i + 1]; pixels[o++] = rgba[i]; pixels[o++] = rgba[i + 3];
    }
  }
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]);
}

/** An .ico file with one image per size, as Windows reads for a program's icon. */
export function ico(sizes = ICON_SIZES) {
  const images = sizes.map((s) => bmpEntry(render(s), s));
  const dir = Buffer.alloc(6 + 16 * sizes.length);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(sizes.length, 4);
  let offset = dir.length;
  sizes.forEach((s, i) => {
    const at = 6 + 16 * i;
    dir[at] = s >= 256 ? 0 : s;
    dir[at + 1] = s >= 256 ? 0 : s;
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(images[i].length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += images[i].length;
  });
  return Buffer.concat([dir, ...images]);
}

/** Write the icon to `file` (build/scopebond.ico by default) and return its path. */
export function writeIcon(file = join(here, "build", "scopebond.ico")) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, ico());
  return file;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(`wrote ${writeIcon(process.argv[2] ? resolve(process.argv[2]) : undefined)}`);
}
