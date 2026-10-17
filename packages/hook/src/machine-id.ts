// This computer's machine id for its workspace: a one-way hash of the operating system's machine id with the workspace's
// id (see @scopebond/gateway's machine-id), so a workspace can tell that a computer connecting again is the same one. The
// raw OS id never leaves this computer and is never written, logged or shown; only the hash is sent, in the body of a
// sign-in or enrollment and in the `x-scopebond-machine-id` header of a rules check, a delivery or an observation upload.
// It is kept in machine-id.json beside cloud.json with the scope it was computed for. No machine id, nothing is sent.

import { join } from "node:path";
import { cachedMachineId } from "@scopebond/gateway/node";

/** The file in the Scopebond folder that keeps the machine id (a hash) and its scope. */
export const MACHINE_ID_FILE = "machine-id.json";

/** The machine id for the Scopebond folder `dir`, in the scope of `workspaceId` (the connected workspace's id) when it is
 *  known, else the workspace this folder last enrolled with, else unscoped. Null when the OS machine id cannot be read.
 *  Never throws. */
export function machineIdFor(dir: string, workspaceId?: string | null): string | null {
  return cachedMachineId(join(dir, MACHINE_ID_FILE), workspaceId);
}

/** The `machine_id` field a sign-in request carries: the machine id for `dir` in the scope of the workspace it is connected
 *  to or last enrolled with (unscoped before), or no field without one. */
export function machineIdField(dir: string, workspaceId?: string | null): { machine_id?: string } {
  const id = machineIdFor(dir, workspaceId);
  return id ? { machine_id: id } : {};
}

/** The workspace id a device sign-in's approval names (`organization_id`), or null. */
export function approvedWorkspaceId(answer: Record<string, unknown>): string | null {
  const id = answer.organization_id;
  return typeof id === "string" && id.trim() && id.length <= 256 ? id : null;
}
