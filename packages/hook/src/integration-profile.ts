import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { placeOwnerOnly } from "@scopebond/gateway/node";
import { adapterProfileHome, type AdapterProfile } from "./adapters.js";
import { readConfigText } from "./config-edit.js";
import { userHome } from "./install.js";

export const INTEGRATION_PROFILE_FILE = "integration-profile.json";
export interface IntegrationProfile { id: string | null; state: "bound" | "unbound" | "mismatch" | "unknown" }
interface Binding { version: 1; id: string; salt: string; binding: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A random profile identifier, separate from a machine or billable person/tool. A copied state directory cannot silently
 *  authorize automatic configuration in another profile. The local binding contains no raw path and never leaves disk. */
export function integrationProfile(dir = userHome(), profile: AdapterProfile = {}, options: { create?: boolean } = {}): IntegrationProfile {
  try {
    const file = join(dir, INTEGRATION_PROFILE_FILE);
    let home = adapterProfileHome(profile);
    if ((profile.platform ?? process.platform) === "win32") home = home.toLowerCase();
    const binding = (salt: string) => createHmac("sha256", salt).update(home).digest("hex");
    let text = readConfigText(file);
    if (text === undefined) {
      if (options.create === false) return { id: null, state: "unbound" };
      const salt = randomBytes(32).toString("hex");
      const candidate: Binding = { version: 1, id: randomUUID(), salt, binding: binding(salt) };
      // Exclusive creation makes simultaneous first scans agree on the winner's identifier.
      placeOwnerOnly(file, JSON.stringify(candidate) + "\n", true);
      text = readConfigText(file);
    }
    if (!text || text.length > 1024) return { id: null, state: "unknown" };
    const value = JSON.parse(text) as Partial<Binding> | null;
    if (!value || value.version !== 1 || typeof value.id !== "string" || !uuid.test(value.id)
      || typeof value.salt !== "string" || !/^[a-f0-9]{64}$/.test(value.salt) || typeof value.binding !== "string") return { id: null, state: "unknown" };
    return value.binding === binding(value.salt) ? { id: value.id, state: "bound" } : { id: null, state: "mismatch" };
  } catch { return { id: null, state: "unknown" }; }
}
