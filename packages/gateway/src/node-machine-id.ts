// Node-only: this computer's machine id for its workspace (see machine-id.ts for the form and where it travels).
//
// The raw id is the operating system's own: on Windows `MachineGuid` under HKLM\SOFTWARE\Microsoft\Cryptography, on macOS
// `IOPlatformUUID` (from `ioreg`), on Linux /etc/machine-id or else /var/lib/dbus/machine-id. It is trimmed and
// lowercased, hashed with the scope, and only the hash is kept or sent: the raw id is never written, logged or shown. When
// none can be read, there is no machine id and nothing is sent; a host name or a network address is never used instead.
//
// The hash is kept in a small file in the client's own folder, with the scope it was computed for, and computed again
// when the scope changes (unscoped until the workspace's id is known) and once a day, so a folder copied to another
// computer does not carry the first computer's id for long.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { MACHINE_ID_DOMAIN, MACHINE_ID_UNSCOPED, isMachineId } from "./machine-id.js";
import { readIfPresent, placeOwnerOnly } from "./node-files.js";
import { windowsSystemProgram } from "./node-programs.js";

/** The longest raw id or scope used; anything longer is not one. */
const MAX_LENGTH = 256;
// Control characters (a newline would change what the hash covers).
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\x00-\x1f\x7f]/;

/** The raw id as it is hashed (trimmed, lowercase), or null when it is not a usable id. */
export function normalizeRawMachineId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  // systemd writes "uninitialized" into /etc/machine-id until the first boot has finished.
  if (!value || value.length > MAX_LENGTH || CONTROL.test(value) || value === "uninitialized") return null;
  return value;
}

/** The scope a machine id is computed with: the workspace's id when it is a usable one, else "unscoped". */
export function machineIdScope(workspaceId: unknown): string {
  if (typeof workspaceId !== "string") return MACHINE_ID_UNSCOPED;
  const value = workspaceId.trim();
  return value && value.length <= MAX_LENGTH && !CONTROL.test(value) ? value : MACHINE_ID_UNSCOPED;
}

/** The machine id for the raw OS id `raw` in `scope` (a workspace's id, or unscoped), or null when `raw` is not usable. */
export function computeMachineId(raw: string, scope?: string | null): string | null {
  const id = normalizeRawMachineId(raw);
  if (id === null) return null;
  const digest = createHash("sha256").update(`${MACHINE_ID_DOMAIN}\n${machineIdScope(scope)}\n${id}`, "utf8").digest("base64url");
  return `m1:${digest}`;
}

/** The value of `MachineGuid` in what `reg query` printed, or null. */
export function parseRegQueryMachineGuid(output: string): string | null {
  // Line by line, split on whitespace: no pattern that could backtrack over a long line.
  for (const line of output.split("\n")) {
    const [name, type, ...value] = line.trim().split(/\s+/);
    if (name?.toLowerCase() === "machineguid" && type === "REG_SZ" && value.length > 0) return normalizeRawMachineId(value.join(" "));
  }
  return null;
}

/** The value of `IOPlatformUUID` in what `ioreg -rd1 -c IOPlatformExpertDevice` printed, or null. */
export function parseIoregPlatformUuid(output: string): string | null {
  const match = /"IOPlatformUUID"\s*=\s*"([^"\r\n]+)"/.exec(output);
  return match ? normalizeRawMachineId(match[1]) : null;
}

/** How the raw id is read. Tests pass their own. */
export interface MachineIdReaders {
  platform?: NodeJS.Platform;
  /** Run a program (by full path) and return what it printed; throws when it fails. */
  run?: (file: string, args: string[]) => string;
  /** A file's text; throws when it cannot be read. */
  readFile?: (path: string) => string;
  env?: NodeJS.ProcessEnv;
}

export const WINDOWS_MACHINE_GUID_KEY = "HKLM\\SOFTWARE\\Microsoft\\Cryptography";
export const MACOS_IOREG = "/usr/sbin/ioreg";
export const LINUX_MACHINE_ID_FILES = ["/etc/machine-id", "/var/lib/dbus/machine-id"] as const;

const defaultRun = (file: string, args: string[]): string =>
  execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 });

/** This computer's raw OS machine id (trimmed, lowercase), or null when none can be read. Never throws. The value is for
 *  hashing here only: never send, log or store it. */
export function readRawMachineId(readers: MachineIdReaders = {}): string | null {
  const platform = readers.platform ?? process.platform;
  const run = readers.run ?? defaultRun;
  const readFile = readers.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  try {
    if (platform === "win32") {
      // The 64-bit registry view: a 32-bit process would otherwise be shown a copy without the value.
      return parseRegQueryMachineGuid(run(windowsSystemProgram("reg", readers.env), ["query", WINDOWS_MACHINE_GUID_KEY, "/v", "MachineGuid", "/reg:64"]));
    }
    if (platform === "darwin") return parseIoregPlatformUuid(run(MACOS_IOREG, ["-rd1", "-c", "IOPlatformExpertDevice"]));
    if (platform === "linux") {
      for (const file of LINUX_MACHINE_ID_FILES) {
        try {
          const id = normalizeRawMachineId(readFile(file));
          if (id) return id;
        } catch { /* try the next one */ }
      }
    }
  } catch { /* no machine id */ }
  return null;
}

/** This computer's machine id in the scope of `workspaceId` (unscoped without one), or null when no raw id can be read. */
export function machineId(workspaceId?: string | null, readers?: MachineIdReaders): string | null {
  const raw = readRawMachineId(readers);
  return raw === null ? null : computeMachineId(raw, workspaceId);
}

/** What the machine id file holds. */
interface MachineIdCache {
  version: 1;
  scope: string;
  /** The machine id, or null when none could be read when it was last tried. */
  machine_id: string | null;
  /** When it was worked out (ms since epoch). */
  checked_at: number;
}

/** How long a kept machine id is used before it is worked out again (a found one and a missing one alike). */
export const MACHINE_ID_RECHECK_MS = 24 * 60 * 60 * 1000;

function readCache(file: string): MachineIdCache | null {
  try {
    const text = readIfPresent(file);
    if (text === undefined || text.length > 4096) return null;
    const parsed = JSON.parse(text) as Partial<MachineIdCache>;
    if (parsed.version !== 1 || typeof parsed.scope !== "string" || machineIdScope(parsed.scope) !== parsed.scope) return null;
    if (parsed.machine_id !== null && !isMachineId(parsed.machine_id)) return null;
    if (typeof parsed.checked_at !== "number" || !Number.isFinite(parsed.checked_at)) return null;
    return parsed as MachineIdCache;
  } catch { return null; }
}

export interface CachedMachineIdOptions {
  readers?: MachineIdReaders;
  now?: () => number;
}

/** This computer's machine id, kept in `file` (JSON, owner-only) with the scope it was computed for. The scope is
 *  `workspaceId` when known, else the workspace scope `file` already holds, else unscoped. Worked out again when the scope
 *  changes or the kept one is a day old. Null when no raw id can be read. Never throws: a file that cannot be written only
 *  means the id is worked out again next time. */
export function cachedMachineId(file: string, workspaceId?: string | null, options: CachedMachineIdOptions = {}): string | null {
  try {
    const now = (options.now ?? Date.now)();
    const cached = readCache(file);
    // An install enrolled with a workspace keeps that workspace's scope while it does not know one now.
    const known = machineIdScope(workspaceId);
    const scope = known !== MACHINE_ID_UNSCOPED ? known : cached?.scope ?? MACHINE_ID_UNSCOPED;
    if (cached && cached.scope === scope && now >= cached.checked_at && now - cached.checked_at < MACHINE_ID_RECHECK_MS) return cached.machine_id;
    const id = machineId(scope, options.readers);
    const next: MachineIdCache = { version: 1, scope, machine_id: id, checked_at: now };
    try { placeOwnerOnly(file, JSON.stringify(next, null, 2) + "\n", false); } catch { /* worked out again next time */ }
    return id;
  } catch { return null; }
}
