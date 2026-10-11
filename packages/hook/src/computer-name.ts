// The computer name this install sends its workspace.
//
// Signing in sends the computer's name (`os.hostname()`) so the person approving the sign-in, and later the
// workspace's list of computers, can tell which computer it is. A host name often carries a person's name
// (`JANES-LAPTOP`), so it can be sent as a short stable hash instead, or not at all:
//
//   SCOPEBOND_HOSTNAME_MODE=full   the host name as the system reports it (the default)
//   SCOPEBOND_HOSTNAME_MODE=hash   the first 12 hex characters of the SHA-256 of the lower-cased host name: the same
//                                  computer always sends the same value, and the value does not give the name back
//   SCOPEBOND_HOSTNAME_MODE=off    no computer name; the workspace names the computer itself
//
// An unknown value is read as `hash`: someone who set the variable wanted less sent, not more.

import { createHash } from "node:crypto";
import { hostname } from "node:os";

export type HostnameMode = "full" | "hash" | "off";

export const HOSTNAME_MODE_ENV = "SCOPEBOND_HOSTNAME_MODE";

/** The mode `SCOPEBOND_HOSTNAME_MODE` sets: `full` when unset or empty, `hash` for an unknown value. */
export function hostnameMode(env: NodeJS.ProcessEnv = process.env): HostnameMode {
  const raw = (env[HOSTNAME_MODE_ENV] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "full") return "full";
  if (raw === "off" || raw === "none") return "off";
  return "hash";
}

/** A short, stable stand-in for a host name: the first 12 hex characters of the SHA-256 of its lower-cased form. */
export function hashedHostname(name: string): string {
  return createHash("sha256").update(name.trim().toLowerCase(), "utf8").digest("hex").slice(0, 12);
}

/** The computer name to send, or null when none is sent (`off`, or the system has no name to give). */
export function computerName(mode: HostnameMode = hostnameMode(), name?: string): string | null {
  if (mode === "off") return null;
  let host = name;
  if (host === undefined) { try { host = hostname(); } catch { host = ""; } }
  if (host.trim() === "") return null;
  return mode === "hash" ? hashedHostname(host) : host;
}

/** The sign-in request's `client_name` field: present unless the mode is `off`. */
export function clientNameField(mode: HostnameMode = hostnameMode(), name?: string): { client_name?: string } {
  const value = computerName(mode, name);
  return value === null ? {} : { client_name: value };
}
