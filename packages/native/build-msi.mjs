// Build the Windows installer around the single executable (Windows only, WiX 5 as a local dotnet tool).
//
//   node build-msi.mjs [path\to\scopebond-agent.exe]   → build/scopebond-agent-<version>-x64.msi
//
// The executable is taken as given (the release workflow signs it first, then signs the installer).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WIX_UTIL = "WixToolset.Util.wixext/5.0.2";

export function buildMsi(exe = join(here, "build", "scopebond-agent.exe")) {
  if (process.platform !== "win32") throw new Error("the installer is built on Windows");
  if (!existsSync(exe)) throw new Error(`no executable at ${exe}; build it first (build-sea.mjs)`);
  const version = JSON.parse(readFileSync(join(here, "..", "agent", "package.json"), "utf8")).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`an installer version is three numbers, not ${version}`);
  const out = join(here, "build", `scopebond-agent-${version}-x64.msi`);
  const run = (args) => execFileSync("dotnet", args, { cwd: here, stdio: "inherit" });
  run(["tool", "restore"]);
  run(["tool", "run", "wix", "extension", "add", WIX_UTIL]);
  run(["tool", "run", "wix", "build", "-arch", "x64", "-ext", WIX_UTIL, "-d", `Version=${version}`, "-d", `ExePath=${resolve(exe)}`,
    "-o", out, join(here, "wix", "Package.wxs")]);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(`built ${buildMsi(process.argv[2])}`);
}
