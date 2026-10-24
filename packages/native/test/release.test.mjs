// The signed release: build tools never run where a signing token can be asked for, a release without its signed
// manifest fails, the publisher check is the updater's anchored rule, and the tray's crates are in the SBOM and the
// dependency scan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISHER } from "@scopebond/agent";
import { cargoCrates, sbom } from "../sbom.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const native = join(here, "..");
const root = join(native, "..", "..");
const workflow = (name) => readFileSync(join(root, ".github", "workflows", name), "utf8");

/** The jobs of a workflow, by name, each as its own text (two-space job keys under `jobs:`). */
function jobs(text) {
  const body = text.slice(text.indexOf("\njobs:\n") + 7);
  const out = {};
  let name = null;
  for (const line of body.split("\n")) {
    const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (m) { name = m[1]; out[name] = ""; continue; }
    if (name && !line.trim().startsWith("#")) out[name] += `${line}\n`;
  }
  return out;
}

test("no build tool or dependency runs in a release job that can ask for the signing token", () => {
  const all = jobs(workflow("native-release.yml"));
  const signing = Object.entries(all).filter(([, text]) => /id-token:\s*write/.test(text));
  assert.deepEqual(signing.map(([name]) => name).sort(), ["sign", "sign-installer", "sign-macos"]);
  for (const [name, text] of signing.filter(([n]) => n !== "sign-macos")) {
    for (const tool of ["dotnet", "build-msi", "wix ", "pnpm install", "cargo ", "npm install", "npx "]) {
      assert.ok(!text.includes(tool), `${name} runs ${tool.trim()} with the signing token in reach`);
    }
  }
  assert.ok(!/id-token/.test(all.installer), "the installer job has no OIDC token");
  assert.match(all.installer, /node packages\/native\/build-msi\.mjs out\/scopebond-agent\.exe out\/scopebond-tray\.exe/);
  assert.match(all.installer, /verify-signed\.ps1 -Folder out/, "it checks the signed programs before it builds around them");
  assert.match(all["sign-installer"], /needs: \[build, installer\]/);
  // The Apple signing installs nothing either: it signs what build-macos built, with Apple's tools and the package script.
  for (const tool of ["dotnet", "wix ", "pnpm ", "cargo ", "npm install", "npx ", "build-sea"]) {
    assert.ok(!all["sign-macos"].includes(tool), `sign-macos runs ${tool.trim()} with the signing token in reach`);
  }
  assert.match(all["sign-macos"], /needs: build-macos/);
  assert.match(all["sign-macos"], /name: unsigned-macos-\$\{\{ matrix\.arch \}\}/);
  assert.ok(!/id-token/.test(all["build-macos"]), "the macOS build has no OIDC token");
  assert.match(all.release, /needs: \[build, sign-installer, defender-scan, build-macos, sign-macos\]/);
  // The macOS build must pass; its signed files join only when Apple signing ran.
  assert.match(all.release, /needs\.build-macos\.result == 'success'/);
  assert.match(all.release, /needs\.sign-macos\.result == 'success' \|\| needs\.sign-macos\.result == 'skipped'/);
  // With the macOS files in it, SHA256SUMS is written again over every file of the release.
  assert.match(all.release, /xargs sha256sum > "\$RUNNER_TEMP\/SHA256SUMS"/);
  assert.match(all.release, /mv "\$RUNNER_TEMP\/SHA256SUMS" out\/SHA256SUMS/);
});

test("Microsoft Defender scans the programs and the signed files before a release exists", () => {
  const all = jobs(workflow("native-release.yml"));
  assert.match(all.build, /defender-scan\.ps1 packages\/native\/build\/scopebond-agent\.exe packages\/native\/build\/scopebond-tray\.exe/);
  assert.match(all["defender-scan"], /needs: sign-installer/);
  assert.match(all["defender-scan"], /defender-scan\.ps1 @files/);
  assert.ok(!/id-token/.test(all["defender-scan"]), "the scan has no OIDC token");
  const script = readFileSync(join(native, "defender-scan.ps1"), "utf8");
  assert.match(script, /Update-MpSignature/, "it scans on current definitions");
  assert.match(script, /-DisableRemediation/, "it never removes a file");
  assert.match(script, /exit 1/, "a detection or a scan that cannot run stops the release");
});

test("every signature check in the release uses the updater's anchored publisher rule", () => {
  const script = readFileSync(join(native, "verify-signed.ps1"), "utf8");
  const rule = /^\$Publisher = '([^']+)'$/m.exec(script)?.[1];
  assert.equal(rule, PUBLISHER.source, "the same rule as the updater's PUBLISHER");
  assert.match(script, /\$subject -cnotmatch \$Publisher/, "matched case-sensitively, as the updater does");
  const text = workflow("native-release.yml");
  assert.doesNotMatch(text, /-notmatch 'O=Avouro LLC'/, "no unanchored publisher check is left");
  assert.match(jobs(text)["sign-installer"], /verify-signed\.ps1 -Folder out -SignTool/);
  for (const subject of ["CN=Avouro LLC, O=Avouro LLC, L=Okemos, S=Michigan, C=US", "O=Avouro LLC"]) assert.ok(PUBLISHER.test(subject), subject);
  for (const subject of ["CN=x, O=Avouro LLC Ltd, C=US", "CN=O=Avouro LLC x", "O=avouro llc", "CN=Avouro LLC, O=Someone Else"]) assert.ok(!PUBLISHER.test(subject), subject);
});

test("a release without the updater key fails instead of passing without a manifest", () => {
  const folder = mkdtempSync(join(tmpdir(), "sb-manifest-cli-"));
  writeFileSync(join(folder, "scopebond-agent-1.2.3-x64.msi"), "msi");
  const env = { ...process.env };
  delete env.UPDATER_SIGNING_KEY;
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const missing = spawnSync(process.execPath, [join(native, "manifest.mjs"), "1.2.3", folder, commit], { encoding: "utf8", env });
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /UPDATER_SIGNING_KEY is not set/);
  assert.equal(existsSync(join(folder, "scopebond-agent-1.2.3.manifest.json")), false);
  const { privateKey } = generateKeyPairSync("ed25519");
  const signed = spawnSync(process.execPath, [join(native, "manifest.mjs"), "1.2.3", folder, commit], {
    encoding: "utf8", env: { ...env, UPDATER_SIGNING_KEY: privateKey.export({ type: "pkcs8", format: "pem" }) },
  });
  assert.equal(signed.status, 0, signed.stderr);
  assert.ok(existsSync(join(folder, "scopebond-agent-1.2.3.manifest.json.sig")));
});

test("the SBOM names every crate in the tray's Cargo.lock, and the dependency scan reads that lockfile", () => {
  const sample = `version = 4\n\n[[package]]\nname = "scopebond-tray"\nversion = "0.1.0"\ndependencies = [\n "serde",\n]\n\n[[package]]\nname = "serde"\nversion = "1.0.228"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "abc"\n\n[[package]]\nname = "forked"\nversion = "0.2.0"\nsource = "git+https://example.com/forked?rev=1#1"\n`;
  assert.deepEqual(cargoCrates(sample), [{ name: "forked", version: "0.2.0", registry: false }, { name: "serde", version: "1.0.228", registry: true }]);
  const lock = readFileSync(join(root, "packages", "tray", "Cargo.lock"), "utf8");
  const crates = cargoCrates(lock);
  const declared = (lock.match(/^\[\[package\]\]$/gm) ?? []).length;
  assert.equal(crates.length, declared - 1, "every crate but the tray itself");
  const bom = sbom({ inputs: {} }, "22.20.0", lock);
  const purls = new Set(bom.components.map((c) => c.purl));
  const tauri = crates.find((c) => c.name === "tauri");
  assert.ok(tauri && purls.has(`pkg:cargo/tauri@${tauri.version}`));
  assert.ok(crates.every((c) => purls.has(c.registry ? `pkg:cargo/${c.name}@${c.version}` : `pkg:generic/${c.name}@${c.version}`)));
  assert.ok(!bom.components.some((c) => c.name === "scopebond-tray"));
  assert.ok(purls.has("pkg:generic/node@22.20.0"));

  assert.match(workflow("security-audit.yml"), /osv-scanner scan source --lockfile pnpm-lock\.yaml --lockfile packages\/tray\/Cargo\.lock /);
  assert.ok(existsSync(join(root, "packages", "tray", "osv-scanner.toml")));
});

test("the tray's checks run when the agent or the hook it starts changes", () => {
  const on = workflow("tray.yml").split("\njobs:")[0];
  for (const path of ["packages/tray/**", "packages/native/**", "packages/agent/**", "packages/hook/**", ".github/workflows/tray.yml"]) {
    assert.ok(on.includes(`- "${path}"`), path);
  }
  // Its own workflow file, not every workflow: another workflow's change does not build the tray.
  assert.ok(!on.includes(`- ".github/workflows/**"`));
});

test("a pull request builds the release only when the release workflow or its release-only tooling changes", () => {
  const on = workflow("native-release.yml").split("\npermissions:")[0];
  const paths = [...on.split(/^ {2}pull_request:/m)[1].matchAll(/^ {6}- (\S+)$/gm)].map((m) => m[1]);
  assert.ok(paths.includes(".github/workflows/native-release.yml"));
  assert.ok(paths.includes("packages/native/stamp.mjs") && paths.includes("packages/native/wix/**"));
  // ci.yml builds and runs the executable and the MSI, and tray.yml builds the tray, on every pull request.
  for (const covered of ["packages/native/**", "packages/tray/**", "packages/native/build-sea.mjs", "packages/native/build-msi.mjs"]) {
    assert.ok(!paths.includes(covered), covered);
  }
});

test("on Windows, the signature check refuses an unsigned program and one signed by another publisher", { skip: process.platform !== "win32" && "Windows only" }, () => {
  // Windows PowerShell, without the module path a PowerShell 7 parent (CI's shell) would hand it.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== "psmodulepath"));
  const run = (folder) => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(native, "verify-signed.ps1"), "-Folder", folder], { encoding: "utf8", env });
  const unsigned = mkdtempSync(join(tmpdir(), "sb-verify-unsigned-"));
  writeFileSync(join(unsigned, "scopebond-agent.exe"), "not a program");
  const a = run(unsigned);
  assert.notEqual(a.status, 0);
  assert.match(`${a.stdout}${a.stderr}`, /scopebond-agent\.exe: (NotSigned|UnknownError|HashMismatch)/);
  const other = mkdtempSync(join(tmpdir(), "sb-verify-other-"));
  copyFileSync(process.execPath, join(other, "scopebond-agent.exe"));
  const b = run(other);
  assert.notEqual(b.status, 0);
  // Node is signed by its own publisher (an unsigned build says NotSigned instead).
  assert.match(`${b.stdout}${b.stderr}`, /unexpected publisher|NotSigned/);
});

test("the engine bundle is built where nothing can sign, signed with the updater key before the sums, attested and released", () => {
  const all = jobs(workflow("native-release.yml"));
  assert.match(all.build, /node packages\/native\/hook-bundle\.mjs build packages\/native\/dist\/hook-bundle "\$env:COMMIT"/);
  assert.match(all.build, /name: unsigned-hook-bundle/);
  assert.ok(!all.build.includes("UPDATER_SIGNING_KEY"), "the build job has no signing key");
  const signJob = all["sign-installer"];
  assert.match(signJob, /name: unsigned-hook-bundle/);
  const signStep = signJob.indexOf("node packages/native/hook-bundle.mjs sign out");
  assert.ok(signStep > 0, "the sign-installer job signs the bundle manifest");
  assert.ok(signStep < signJob.indexOf("SHA256SUMS"), "before the sums, so they list the signed manifest");
  assert.match(signJob.slice(signJob.lastIndexOf("- name:", signStep)), /UPDATER_SIGNING_KEY: \$\{\{ secrets\.UPDATER_SIGNING_KEY \}\}/);
  assert.match(signJob, /out\/scopebond-hook-bundle-\*\.tgz/, "the bundle is attested");
  const on = workflow("native-release.yml").split("\npermissions:")[0];
  for (const path of ["packages/native/hook-bundle.mjs", "packages/native/src/hook-bundle-main.mjs"]) assert.ok(on.includes(`- ${path}`), path);
});

test("signing the bundle without the updater key fails instead of releasing an unsigned one", () => {
  const env = { ...process.env };
  delete env.UPDATER_SIGNING_KEY;
  const out = spawnSync(process.execPath, [join(native, "hook-bundle.mjs"), "sign", mkdtempSync(join(tmpdir(), "sb-bundle-cli-")), "0123456789abcdef0123456789abcdef01234567"], { encoding: "utf8", env });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /UPDATER_SIGNING_KEY is not set/);
});
