// The machine id a client sends its workspace, so the workspace can tell that a computer connecting again is the same
// computer. It is a one-way hash of the operating system's own machine id (see node-machine-id.ts, which reads and hashes
// it): `m1:` and the unpadded base64url SHA-256 of "scopebond-machine-id/v1\n" + scope + "\n" + raw id, where the scope
// is the workspace's id once the client knows it and "unscoped" before. The raw id never leaves the computer.
//
// This part is edge-safe: what the id looks like and how a request carries it. Enrollment sends it in its JSON body
// (`machine_id`); check-ins send it in the `x-scopebond-machine-id` header. A client that could not read a machine id
// sends nothing.

/** The header a check-in (rules check, record delivery, observations) carries the machine id in. */
export const MACHINE_ID_HEADER = "x-scopebond-machine-id";

/** The scope a machine id is computed with before the client knows its workspace's id. */
export const MACHINE_ID_UNSCOPED = "unscoped";

/** The domain separator hashed in front of the scope and the raw id. */
export const MACHINE_ID_DOMAIN = "scopebond-machine-id/v1";

const MACHINE_ID = /^m1:[A-Za-z0-9_-]{43}$/;

/** Whether `value` is a machine id in the form a workspace accepts (`m1:` and 43 base64url characters). */
export function isMachineId(value: unknown): value is string {
  return typeof value === "string" && MACHINE_ID.test(value);
}

/** A machine id, or a function that works it out when a request is about to be made. */
export type MachineIdSource = string | null | undefined | (() => string | null | undefined);

/** The machine id from `source`, or null when there is none or it is not well formed. Never throws. */
export function resolveMachineId(source: MachineIdSource): string | null {
  try {
    const value = typeof source === "function" ? source() : source;
    return isMachineId(value) ? value : null;
  } catch { return null; }
}

/** The header that carries the machine id, or no header when there is none. */
export function machineIdHeaders(source: MachineIdSource): Record<string, string> {
  const id = resolveMachineId(source);
  return id ? { [MACHINE_ID_HEADER]: id } : {};
}
