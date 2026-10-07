# @scopebond/native (not published)

The single-file Scopebond Agent and hook: a [Node single executable application](https://nodejs.org/api/single-executable-applications.html)
built from `@scopebond/agent` and `@scopebond/hook`. One file is both:

- the Scopebond Agent: `scopebond-agent.exe run`, `status`, `check`, … (the same commands as `scopebond-agent` from npm);
- the hook a coding agent runs for each tool call: `scopebond-agent.exe hook claude` (or `cursor`, `codex`), and every
  other hook command after `hook` (`hook init`, `hook log`, `hook rules`, …).

It needs neither npm nor npx at run time, and it is the file the signed Windows installer ships.

## Build

```sh
pnpm -r build
node packages/native/build-sea.mjs     # → packages/native/build/scopebond-agent(.exe)
```

The build bundles the agent and the hook into one CommonJS file with esbuild (versions fixed at build time), makes a
single executable application blob with a code cache, copies the Node that runs the build, removes that copy's own
signature and injects the blob with postject. It is unsigned; the release workflow signs it.

## Test

`node --test packages/native/test/` checks the bundle everywhere. With `SCOPEBOND_SEA=1` it also builds the executable
and checks that it decides Claude Code calls exactly as the npm hook does and how quickly it starts (CI runs this on
Windows).

## Release (signed)

`.github/workflows/native-release.yml`, run by hand from `main`:

1. **build** (windows-latest, no secrets): the executable and its CycloneDX SBOM (`sbom.mjs`, from the bundle's metafile).
2. **sign**, in the protected `signing` environment (an owner approves each run; protected branches only): Azure
   Artifact Signing through GitHub's OIDC token (no stored secret), every signature timestamped; then `signtool verify
   /pa`, a check that the publisher is Avouro LLC and that a timestamp is present, `SHA256SUMS`, and a build provenance
   attestation (`gh attestation verify <file> --repo avouro-com/scopebond`).
3. **sign-macos**: the Apple build (Developer ID, hardened runtime, notarized), in its own `signing-apple` environment;
   off until `APPLE_SIGNING_ENABLED` is set with the Apple secrets.
4. **release**: a draft, pre-release GitHub release with the signed files, for a person to check and publish.

A fork can run the build job and gets an unsigned file; it cannot reach either signing environment.

## Installer

`node packages/native/build-msi.mjs [scopebond-agent.exe]` builds `build/scopebond-agent-<version>-x64.msi` with WiX 5
(a local dotnet tool, `.config/dotnet-tools.json`; WiX 6 and later carry a maintenance-fee licence term, so the build
stays on 5). The installer:

- installs per user by default, with no administrator prompt (`%LOCALAPPDATA%\Programs\Scopebond`), or for every user
  with `ALLUSERS=1` (Program Files; for Intune or Group Policy);
- records its folder in `HKCU` (or `HKLM`) `\Software\Avouro\Scopebond\InstallPath`, and `WORKSPACE=<url>` as
  `Workspace` there;
- adds a Start-menu entry "Scopebond Agent status" with the AppUserModelID `Avouro.Scopebond`;
- installs a new version before removing the old one, so the hook's executable is never missing for long;
- on removal, first runs `scopebond-agent.exe uninstall` as the person removing it: autostart off, the agent stopped,
  the hook taken out of the coding agents' settings and the workspace told (the Scopebond folder stays).

Signing in, the hook entries and autostart come from `scopebond-agent.exe setup <workspace-url>` after installing, as with
npm. CI installs and removes it, per user and for every user (`test/msi.test.mjs`, only with `SCOPEBOND_MSI=1`).
