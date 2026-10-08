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
  assert.match(all.release, /needs: \[build, sign-installer\]/);
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
  const missing = spawnSync(process.execPath, [join(native, "manifest.mjs"), "1.2.3", folder], { encoding: "utf8", env });
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /UPDATER_SIGNING_KEY is not set/);
  assert.equal(existsSync(join(folder, "scopebond-agent-1.2.3.manifest.json")), false);
  const { privateKey } = generateKeyPairSync("ed25519");
  const signed = spawnSync(process.execPath, [join(native, "manifest.mjs"), "1.2.3", folder], {
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
  for (const path of ["packages/tray/**", "packages/native/**", "packages/agent/**", "packages/hook/**", ".github/workflows/**"]) {
    assert.ok(on.includes(`- "${path}"`), path);
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
