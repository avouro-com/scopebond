// The winget manifests for a signed release (package Avouro.Scopebond): the version, the installer (the signed MSI, per
// user by default and for every user with ALLUSERS=1) and the English description. Submitting them to the community
// repository (microsoft/winget-pkgs) is a publication and stays the owner's step.
//
//   node winget.mjs <version> <msi-url> <msi-sha256> <product-code> [out-folder]   → <out>/Avouro.Scopebond.*.yaml

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ID = "Avouro.Scopebond";
const SCHEMA = "1.9.0";
const header = (kind) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${kind}.${SCHEMA}.schema.json\n`;

export function wingetManifests({ version, url, sha256, productCode }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a version: ${version}`);
  if (!/^https:\/\/github\.com\/avouro-com\/scopebond\/releases\/download\//.test(url)) throw new Error(`not a release download: ${url}`);
  if (!/^[0-9a-f]{64}$/i.test(sha256)) throw new Error("not a SHA-256");
  if (!/^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/i.test(productCode)) throw new Error("not a product code");
  const installer = (scope, custom) => [
    `  - Architecture: x64`,
    `    Scope: ${scope}`,
    `    InstallerUrl: ${url}`,
    `    InstallerSha256: ${sha256.toUpperCase()}`,
    ...(custom ? [`    InstallerSwitches:`, `      Custom: ${custom}`] : []),
  ].join("\n");
  return {
    [`${PACKAGE_ID}.yaml`]: `${header("version")}PackageIdentifier: ${PACKAGE_ID}\nPackageVersion: ${version}\nDefaultLocale: en-US\nManifestType: version\nManifestVersion: ${SCHEMA}\n`,
    [`${PACKAGE_ID}.installer.yaml`]: `${header("installer")}PackageIdentifier: ${PACKAGE_ID}\nPackageVersion: ${version}\nInstallerType: wix\nInstallModes:\n  - silent\n  - silentWithProgress\nUpgradeBehavior: install\nProductCode: '${productCode.toUpperCase()}'\nInstallers:\n${installer("user", null)}\n${installer("machine", "ALLUSERS=1")}\nManifestType: installer\nManifestVersion: ${SCHEMA}\n`,
    [`${PACKAGE_ID}.locale.en-US.yaml`]: `${header("defaultLocale")}PackageIdentifier: ${PACKAGE_ID}\nPackageVersion: ${version}\nPackageLocale: en-US\nPublisher: Avouro LLC\nPublisherUrl: https://scopebond.com\nPublisherSupportUrl: https://github.com/avouro-com/scopebond/issues\nPackageName: Scopebond Agent\nPackageUrl: https://github.com/avouro-com/scopebond\nLicense: Apache-2.0\nLicenseUrl: https://github.com/avouro-com/scopebond/blob/main/LICENSE\nShortDescription: Guardrails and signed records for AI coding agents (Claude Code, Cursor, Codex) on this computer.\nDescription: The Scopebond Agent and hook as one signed program. The hook checks each action a coding agent takes against your rules before it runs and keeps a signed record of it; the agent keeps the rules current and delivers the records to your Scopebond workspace.\nMoniker: scopebond\nTags:\n  - ai-agents\n  - claude-code\n  - cursor\n  - codex\n  - guardrails\nReleaseNotesUrl: https://github.com/avouro-com/scopebond/releases/tag/agent-native-v${version}\nManifestType: defaultLocale\nManifestVersion: ${SCHEMA}\n`,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [version, url, sha256, productCode, out = "winget"] = process.argv.slice(2);
  const files = wingetManifests({ version, url, sha256, productCode });
  const folder = resolve(out);
  mkdirSync(folder, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text);
  console.log(`wrote ${Object.keys(files).length} winget manifests to ${folder}`);
}
