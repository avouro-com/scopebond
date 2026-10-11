// Both programs say what they are: the release's version, Scopebond's names and (the agent) the Scopebond icon, written
// into their version resource before they are signed. Checked on a small program made here, on every platform; the real
// single executable is checked in sea.test.mjs (SCOPEBOND_SEA=1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ResEdit from "resedit";
import { fourPart, readVersionInfo, stampExecutable, versionStrings } from "../stamp.mjs";
import { ICON_SIZES, ico, render } from "../icon.mjs";

const program = () => {
  const file = join(mkdtempSync(join(tmpdir(), "sb-stamp-")), "program.exe");
  writeFileSync(file, Buffer.from(ResEdit.NtExecutable.createEmpty(false, false).generate()));
  return file;
};

test("a release version is four numbers in the version resource", () => {
  assert.equal(fourPart("0.6.5"), "0.6.5.0");
  assert.throws(() => fourPart("0.6"), /three numbers/);
  assert.throws(() => fourPart("0.6.5-rc.1"), /three numbers/);
  assert.throws(() => fourPart("70000.0.0"), /65535/);
  assert.throws(() => versionStrings("node", "1.0.0"), /agent or tray/);
});

test("the agent: Scopebond Agent, the release's version, Avouro LLC, its own file name and the Scopebond icon", () => {
  const file = program();
  stampExecutable(file, "agent", "1.2.3");
  const info = readVersionInfo(file);
  assert.equal(info.fileVersion, "1.2.3.0");
  assert.equal(info.productVersion, "1.2.3.0");
  assert.deepEqual(info.strings, {
    CompanyName: "Avouro LLC",
    FileDescription: "Scopebond Agent",
    FileVersion: "1.2.3.0",
    InternalName: "scopebond-agent.exe",
    LegalCopyright: "Copyright Avouro LLC. Apache-2.0.",
    OriginalFilename: "scopebond-agent.exe",
    ProductName: "Scopebond",
    ProductVersion: "1.2.3.0",
  });
  assert.equal(info.icons, 1, "one icon group: Scopebond's");
});

test("the tray keeps its own icon, and stamping again replaces the version instead of adding one", () => {
  const file = program();
  stampExecutable(file, "tray", "0.9.0");
  stampExecutable(file, "tray", "0.9.1");
  const exe = ResEdit.NtExecutable.from(readFileSync(file));
  const entries = ResEdit.NtExecutableResource.from(exe).entries;
  assert.equal(entries.filter((e) => e.type === 16).length, 1, "one version resource");
  const info = readVersionInfo(file);
  assert.equal(info.fileVersion, "0.9.1.0");
  assert.equal(info.strings.FileDescription, "Scopebond tray");
  assert.equal(info.strings.OriginalFilename, "scopebond-tray.exe");
  assert.equal(info.icons, 0, "no icon added to the tray");
});

test("the icon is the tray's: a navy tile with a cream S and transparent corners, at every size Windows asks for", () => {
  const pixel = (image, size, x, y) => [...image.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
  const close = (p, hex) => [hex >> 16, (hex >> 8) & 0xff, hex & 0xff].every((c, i) => Math.abs(p[i] - c) <= 3) && p[3] === 255;
  const image = render(64);
  assert.equal(pixel(image, 64, 0, 0)[3], 0, "a transparent corner");
  assert.ok(close(pixel(image, 64, 8, 32), 0x1b3a5c), "the navy tile");
  assert.ok(close(pixel(image, 64, 30, 32), 0xf7f4ee), "the middle of the S");
  const file = ico();
  assert.deepEqual([...file.subarray(0, 4)], [0, 0, 1, 0]);
  assert.equal(file.readUInt16LE(4), ICON_SIZES.length);
  assert.deepEqual(ICON_SIZES.map((_, i) => file[6 + 16 * i]), ICON_SIZES.map((s) => (s >= 256 ? 0 : s)));
  assert.equal(ResEdit.Data.IconFile.from(file).icons.length, ICON_SIZES.length, "resedit reads it as an icon file");
});
