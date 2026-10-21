// The optional plugin component (the hook's intel-plugin.ts loads it). When the workspace's answer to /v1/client-version
// names `intel: { version, sha256, url }`, the agent fetches the module from the workspace with this computer's credential
// (and its hook version, which the workspace picks the signing key by), checks that its SHA-256 is the one named and that
// the detached signature in the answer's headers verifies against a pinned policy key over
// "scopebond:component/intel/v1\n" + that SHA-256, stages it under `<home>/intel/<version>/` with its manifest
// (`{ version, sha256, signature, key_id }`), and switches `<home>/intel/current` to it. The hook checks all of it again
// before every load.
//
// The credential goes only to the workspace this computer is connected to: an address on another origin is refused. A
// workspace that answers 402 (not licensed), or stops naming a component, has it removed. Under "hold" nothing changes.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkIntelComponent, hookVersion, intelComponentState, intelCurrentDir, intelDir, readIntelManifest, HOOK_VERSION_HEADER,
  INTEL_MANIFEST, INTEL_MAX_BYTES, INTEL_MODULE, type HookConnection, type IntelManifest, type PolicyKey,
} from "@scopebond/hook";

/** The component a workspace names. `url` is on the workspace (absolute, or relative to it). */
export interface IntelTarget { version: string; sha256: string; url: string }

/** The response headers that carry the module's detached signature and the id of the key that made it. */
export const COMPONENT_SIGNATURE_HEADER = "x-scopebond-component-signature";
export const COMPONENT_KEY_ID_HEADER = "x-scopebond-component-key-id";

const VERSION = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,5})$/;

/** The `intel` of an answer, or null when it is absent or not usable (the answer's other fields still count). */
export function readIntelTarget(value: unknown): IntelTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.version !== "string" || !VERSION.test(v.version)) return null;
  if (typeof v.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(v.sha256)) return null;
  if (typeof v.url !== "string" || v.url.length === 0 || v.url.length > 2048) return null;
  return { version: v.version, sha256: v.sha256, url: v.url };
}

export interface IntelOutcome { action: "none" | "installed" | "removed" | "refused" | "not_licensed"; version?: string; reason?: string }

export interface IntelInstallOptions {
  dir: string;
  connection: Pick<HookConnection, "url" | "credential"> | null;
  target: { policy: "recommended" | "hold"; intel?: IntelTarget | null } | null;
  fetchImpl?: typeof fetch;
  /** The pinned policy keys (default: the hook's). */
  keys?: readonly PolicyKey[];
  log?: (line: string) => void;
  now?: () => Date;
}

/** Take `<home>/intel/current` away (the hook then loads nothing). */
function removeCurrent(dir: string): boolean {
  const current = intelCurrentDir(dir);
  if (!existsSync(current)) return false;
  rmSync(current, { recursive: true, force: true });
  return true;
}

/** Write a folder whole: into `<folder>.incoming-<pid>`, then renamed into place (the old one removed just before). */
function writeFolder(folder: string, files: Record<string, Buffer | string>): void {
  const incoming = `${folder}.incoming-${process.pid}`;
  rmSync(incoming, { recursive: true, force: true });
  mkdirSync(incoming, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(incoming, name), bytes, { mode: 0o600 });
  rmSync(folder, { recursive: true, force: true });
  renameSync(incoming, folder);
}

/** One pass: install, switch to, or remove the component the workspace names. Never throws. */
export async function maintainIntel(o: IntelInstallOptions): Promise<IntelOutcome> {
  const log = o.log ?? (() => {});
  try {
    if (!o.target || !o.connection || o.target.policy !== "recommended") return { action: "none" };
    const want = o.target.intel ?? null;
    if (!want) {
      if (removeCurrent(o.dir)) { log("the workspace no longer names a plugin component; it was removed"); return { action: "removed" }; }
      return { action: "none" };
    }
    const options = { ...(o.keys ? { keys: o.keys } : {}), now: (o.now ?? (() => new Date()))() };
    const state = intelComponentState(o.dir, options);
    if (state.ok && state.manifest.version === want.version && state.manifest.sha256 === want.sha256) return { action: "none" };
    const refuse = (reason: string): IntelOutcome => { log(`plugin component ${want.version} was not installed: ${reason}`); return { action: "refused", version: want.version, reason }; };
    // The credential is sent to the workspace's own origin only.
    let url: URL;
    try { url = new URL(want.url, o.connection.url); } catch { return refuse("its address cannot be read"); }
    if (url.origin !== new URL(o.connection.url).origin) return refuse("its address is not on the workspace this computer is connected to");
    let res: Response;
    try {
      res = await (o.fetchImpl ?? fetch)(url.toString(), {
        headers: { authorization: `Bearer ${o.connection.credential}`, [HOOK_VERSION_HEADER]: hookVersion() },
        redirect: "error", signal: AbortSignal.timeout(60_000),
      });
    } catch (error) { return refuse(`the workspace could not be reached (${(error as Error).message.slice(0, 80)})`); }
    if (res.status === 402) {
      removeCurrent(o.dir);
      log("this computer's workspace is not licensed for the plugin component; none is used");
      return { action: "not_licensed", version: want.version };
    }
    if (!res.ok) return refuse(`the workspace answered ${res.status}`);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > INTEL_MAX_BYTES) return refuse("the module is too large");
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > INTEL_MAX_BYTES) return refuse("the module is too large");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== want.sha256) return refuse("the module is not the one the workspace names");
    const signature = res.headers.get(COMPONENT_SIGNATURE_HEADER) ?? "";
    const keyId = res.headers.get(COMPONENT_KEY_ID_HEADER) ?? "";
    const manifest: IntelManifest | null = readIntelManifest({ version: want.version, sha256, signature, ...(keyId ? { key_id: keyId } : {}) });
    if (!manifest) return refuse("the module came without a usable signature");
    const checked = checkIntelComponent(manifest, bytes, options);
    if (!checked.ok) return refuse(checked.reason);
    const manifestText = `${JSON.stringify(manifest)}\n`;
    writeFolder(join(intelDir(o.dir), want.version), { [INTEL_MODULE]: bytes, [INTEL_MANIFEST]: manifestText });
    // `current` is a copy of the version folder (a link needs rights a person may not have on Windows).
    const staged = join(intelDir(o.dir), want.version);
    writeFolder(intelCurrentDir(o.dir), { [INTEL_MODULE]: readFileSync(join(staged, INTEL_MODULE)), [INTEL_MANIFEST]: readFileSync(join(staged, INTEL_MANIFEST)) });
    for (const name of readdirSync(intelDir(o.dir))) {
      if (name !== "current" && name !== want.version) rmSync(join(intelDir(o.dir), name), { recursive: true, force: true });
    }
    log(`plugin component ${want.version} is installed`);
    return { action: "installed", version: want.version };
  } catch (error) {
    log(`the plugin component could not be updated: ${(error as Error).message}`);
    return { action: "refused", reason: (error as Error).message };
  }
}

