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

1. **build** (windows-latest, no secrets): the executable, the native tray (`packages/tray`, `cargo build --release
   --locked` from its committed `Cargo.lock`), and their CycloneDX SBOM (`sbom.mjs`: the bundle's packages from its
   metafile, Node, and every crate in the tray's `Cargo.lock`).
2. **sign**, in the protected `signing` environment (an owner approves it; protected branches only): Azure Artifact
   Signing through GitHub's OIDC token (no stored secret), timestamped, for the executable and the tray. Nothing else
   runs there: no dependency, no build tool.
3. **installer** (no secrets and no OIDC token): checks that both programs are signed by Avouro LLC, then builds the
   installer around them with WiX (`dotnet tool restore`, its extension, `wix build`). The build tools never run in a job
   that can ask for a signing token.
4. **sign-installer**, in the `signing` environment again (a second approval): signs the installer, then
   `verify-signed.ps1` (`signtool verify /pa`, a valid signature, a timestamp, and the publisher: the subject's `O=` is
   exactly `Avouro LLC`, the rule the updater uses), `SHA256SUMS`, the signed release manifest (the run fails without
   `UPDATER_SIGNING_KEY`), the winget manifests and a build provenance attestation (`gh attestation verify <file> --repo
   avouro-com/scopebond`).
5. **sign-macos**: the Apple build (Developer ID, hardened runtime, notarized), in its own `signing-apple` environment;
   off until `APPLE_SIGNING_ENABLED` is set with the Apple secrets.
6. **release**: a draft, pre-release GitHub release with the signed files, for a person to check and publish.

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

**With the native tray** (`node build-msi.mjs <agent.exe> <tray.exe>`, or `SCOPEBOND_TRAY_EXE`; the release always builds
it this way), the installer also:

- installs `scopebond-tray.exe` (`packages/tray`) beside the agent;
- adds a Run value `Scopebond` that starts the tray at sign-in (for this user, or for every user with `ALLUSERS=1`); the
  tray starts the agent and keeps it running, so `autostart on` keeps that value instead of the launcher's
  `ScopebondAgent`;
- starts the tray at the end of a per-user install or upgrade (an install for every user may run as the system account,
  so there each person's sign-in starts it);
- closes the tray before it replaces or removes files, without a reboot prompt;
- points the Start-menu entry at the tray's status panel (`scopebond-tray.exe --status`), keeping its AppUserModelID.

The `tray installer (windows)` job in `.github/workflows/tray.yml` installs it on a throwaway runner, checks that the tray
starts the agent, ends the agent from outside and checks it is back within 30 seconds, checks a second tray gives way, and
removes it: nothing left running, no files, no Run value, no Start-menu entry.

## Updates

A per-user install updates itself when its workspace recommends a newer agent, with the release's installer, after three
checks: the release manifest (`scopebond-agent-<version>.manifest.json`, each file's SHA-256 and size) is signed with the
updater key, an Ed25519 key separate from the Authenticode certificate whose public half (`updater-public-key.txt`) is
built into the program; the downloaded installer's digest and size are the manifest's; and its Authenticode signature is
valid and names Avouro LLC. Then a detached helper stops the native tray (it would start the old agent again, and the
installer replaces its file), waits for the agent to exit, opens the installer so it cannot be changed, checks its size,
SHA-256 and Authenticode signature again, installs it with `msiexec /qn` (Windows' own tools, by their full paths under
the system folder) and starts the tray again, which starts the updated agent (without the tray: the agent again, through
autostart's launcher). If any check fails, nothing is installed and the agent reports that the update could not be
verified. An install for every user (Program Files) never updates itself.

The agent can trust more than one updater key: `updater-keys.json`, when present, lists them as
`{ "kid", "key", "not_after" }` (the key id is the first 16 hex digits of the SHA-256 of the key's SPKI bytes;
`not_after` is the key's last day, `YYYY-MM-DD`, or null). Without it the build trusts the single key in
`updater-public-key.txt`. The signed manifest names the id of the key that signed it, and a key past its `not_after`
signs nothing. To rotate: `node packages/native/updater-key.mjs --add new-key.pem` adds a new key to the list; ship a
release (still signed with the old key) so installs trust both; then switch `UPDATER_SIGNING_KEY` to the new private key,
give the old entry a `not_after`, and remove it once every install has moved.

The updater key is made once by the owner: `node packages/native/updater-key.mjs` writes the public half here and the
private half to a file, which goes into the `signing` environment as `UPDATER_SIGNING_KEY` and is then kept offline. The
release workflow signs the manifest with it (`manifest.mjs`); without it the release fails, because signed installs
update themselves only to a release with a signed manifest.

## Release checklist (owner)

1. Actions → *Native release (signed)* → Run workflow on `main`; approve the `signing` environment when asked (twice: once
   for the programs, once for the installer).
2. Check the draft release: the agent exe, the tray exe and the msi, `SHA256SUMS`, the signed manifest and its `.sig`, the SBOM, the three
   winget manifests; `gh attestation verify scopebond-agent-<version>-x64.msi --repo avouro-com/scopebond`.
3. Submit the exe and the msi to Microsoft's file submission portal (Security Intelligence, as a software developer) so
   Defender and SmartScreen learn them before anyone downloads them; wait for "no malware detected".
4. Publish the release (it stays a pre-release until the signed build has a month of clean installs).
5. winget: submit the three `Avouro.Scopebond.*.yaml` from the release to microsoft/winget-pkgs (for example with
   `wingetcreate submit`). The manifests are generated by `winget.mjs`; the package installs per user by default, and
   `winget install Avouro.Scopebond --scope machine` passes `ALLUSERS=1`.
