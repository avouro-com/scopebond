import { join } from "node:path";
import { HARNESSES, isHarness, type Harness } from "./adapters.js";
import { readIfPresent, replaceFile } from "./safe-fs.js";
import { readHarnessConfig, userHarnessFile, userHome } from "./install.js";

export interface IntegrationIntent { version: 1; automatic: boolean; excluded: Harness[] }
export const INTEGRATION_INTENT_FILE = "integration-intent.json";

/** Invalid intent fails closed to automatic writes. Removing a hook is not sufficient evidence of an exclusion. */
export function readIntegrationIntent(dir = userHome()): IntegrationIntent {
  try {
    const text = readIfPresent(join(dir, INTEGRATION_INTENT_FILE));
    if (text === undefined) return { version: 1, automatic: true, excluded: [] };
    if (text.length > 4096) throw new Error("intent too large");
    const value = JSON.parse(text) as IntegrationIntent;
    if (value.version !== 1 || typeof value.automatic !== "boolean" || !Array.isArray(value.excluded) || value.excluded.length > HARNESSES.length || !value.excluded.every(isHarness)) throw new Error("invalid intent");
    return { version: 1, automatic: value.automatic, excluded: [...new Set(value.excluded)] };
  } catch { return { version: 1, automatic: false, excluded: [...HARNESSES] }; }
}

export function writeIntegrationIntent(intent: IntegrationIntent, dir = userHome()): void {
  if (intent.version !== 1 || typeof intent.automatic !== "boolean" || !Array.isArray(intent.excluded) || intent.excluded.length > HARNESSES.length || !intent.excluded.every(isHarness)) throw new Error("invalid integration intent");
  replaceFile(join(dir, INTEGRATION_INTENT_FILE), JSON.stringify({ version: 1, automatic: intent.automatic, excluded: [...new Set(intent.excluded)] }) + "\n");
}

export function automaticHarnesses(harnesses: readonly Harness[], dir = userHome()): Harness[] {
  const intent = readIntegrationIntent(dir);
  return intent.automatic ? harnesses.filter((h) => {
    if (intent.excluded.includes(h)) return false;
    try { const config = readHarnessConfig(userHarnessFile(h)); return config.disableAllHooks !== true && config.hooksEnabled !== false; }
    catch { return true; } // inspection/repair reports the error; the guarded writer leaves malformed data untouched
  }) : [];
}
