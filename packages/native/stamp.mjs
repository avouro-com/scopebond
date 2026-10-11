// Stamp a program's Windows version resource (VERSIONINFO) before it is signed: the release's version as FileVersion and
// ProductVersion, Scopebond's names, and (for the agent) the Scopebond icon in place of Node's.
//
//   node stamp.mjs <file.exe> agent|tray [version]   (version: the agent package's, by default)
//
// The single executable starts as a copy of node.exe and would otherwise say "Node.js JavaScript Runtime" 22.x in Task
// Manager, Explorer and Settings -> Apps; the tray would say 0.1.0 for ever. Windows Installer compares these file
// versions on an upgrade: a file whose version is not higher than the installed one is left in place, so every release
// must carry its own version in both programs.
//
// Only the version resource (and the icon) change; every other resource stays, the single executable's NODE_SEA_BLOB
// among them. A signature would no longer match, so this runs before signing (the release's build job).

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ResEdit from "resedit";
import { ico } from "./icon.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const RT_VERSION = 16;
const EN_US = 1033;
const UNICODE = 1200;
const VOS_NT_WINDOWS32 = 0x40004;
const VFT_APP = 1;

export const PROGRAMS = {
  agent: { name: "scopebond-agent.exe", description: "Scopebond Agent", icon: true },
  tray: { name: "scopebond-tray.exe", description: "Scopebond tray", icon: false },
};

export const agentVersion = () => JSON.parse(readFileSync(join(here, "..", "agent", "package.json"), "utf8")).version;

/** The four numbers Windows keeps for a release version ("0.6.5" → "0.6.5.0"). */
export function fourPart(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m || m.slice(1).some((n) => Number(n) > 65535)) throw new Error(`a program version is three numbers up to 65535, not ${version}`);
  return `${m[1]}.${m[2]}.${m[3]}.0`;
}

/** The strings the version resource carries for `kind` at `version`. */
export function versionStrings(kind, version) {
  const program = PROGRAMS[kind];
  if (!program) throw new Error(`not a program: ${kind} (agent or tray)`);
  const v = fourPart(version);
  return {
    CompanyName: "Avouro LLC",
    FileDescription: program.description,
    FileVersion: v,
    InternalName: program.name,
    LegalCopyright: "Copyright Avouro LLC. Apache-2.0.",
    OriginalFilename: program.name,
    ProductName: "Scopebond",
    ProductVersion: v,
  };
}

/** Replace the version resource of `file` (and, for the agent, its icon) in place. Returns the strings written. */
export function stampExecutable(file, kind, version = agentVersion()) {
  const strings = versionStrings(kind, version);
  const exe = ResEdit.NtExecutable.from(readFileSync(file), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  // Every language's version resource goes (Node's, the tray build's), and one en-US resource takes its place.
  res.entries = res.entries.filter((entry) => entry.type !== RT_VERSION);
  const info = ResEdit.Resource.VersionInfo.create({
    lang: EN_US,
    fixedInfo: { fileOS: VOS_NT_WINDOWS32, fileType: VFT_APP },
    strings: [{ lang: EN_US, codepage: UNICODE, values: strings }],
  });
  info.setFileVersion(strings.FileVersion, EN_US);
  info.setProductVersion(strings.ProductVersion, EN_US);
  info.outputToResourceEntries(res.entries);
  if (PROGRAMS[kind].icon) {
    const icons = ResEdit.Data.IconFile.from(ico()).icons.map((item) => item.data);
    const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
    if (!groups.length) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, EN_US, icons);
    for (const group of groups) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, icons);
  }
  res.outputResource(exe);
  writeFileSync(file, Buffer.from(exe.generate()));
  return strings;
}

/** What a program's version resource says: the fixed file and product versions and the en-US strings. */
export function readVersionInfo(file) {
  const exe = ResEdit.NtExecutable.from(readFileSync(file), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const [info] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (!info) return null;
  const f = info.fixedInfo;
  const pair = (ms, ls) => `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
  return {
    fileVersion: pair(f.fileVersionMS, f.fileVersionLS),
    productVersion: pair(f.productVersionMS, f.productVersionLS),
    strings: info.getStringValues({ lang: EN_US, codepage: UNICODE }),
    icons: ResEdit.Resource.IconGroupEntry.fromEntries(res.entries).length,
    seaBlob: res.entries.some((entry) => entry.id === "NODE_SEA_BLOB"),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [file, kind, version] = process.argv.slice(2);
  if (!file || !PROGRAMS[kind]) { console.error("usage: node stamp.mjs <file.exe> agent|tray [version]"); process.exit(1); }
  const strings = stampExecutable(resolve(file), kind, version || agentVersion());
  console.log(`stamped ${basename(file)}: ${strings.FileDescription} ${strings.FileVersion}`);
}
