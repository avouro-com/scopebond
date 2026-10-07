// Evidence detail (D144): what this computer sends its workspace. "full" sends every receipt; "standard" sends the notable
// ones in full and the routine ones as one signed summary per five minutes (`buildSummary` in the gateway). Every action keeps
// its own signed receipt here either way, for the retention the workspace set, and the summary's root lets anybody check the
// receipts against it. The workspace names the level on every rules check (`x-scopebond-evidence-detail`); until it does,
// this computer sends every receipt, as before.
//
// Notable, by the gateway's default: anything not plainly allowed (a block, an override, an approval, a timeout, and an action
// a Monitor rule matched, which is recorded as out of policy and allowed), pushes, MCP calls, fetches, writes outside the
// folder or to settings. So a workspace sees every rule match in full.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CloudSummaryOptions } from "@scopebond/gateway";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { readMeta } from "./managed.js";

export type EvidenceDetail = "full" | "standard";

/** The level from the rules check's header; "minimal" is treated as "standard" (notables are always sent in full here). */
export function evidenceDetailFrom(headers: { get(name: string): string | null } | undefined): EvidenceDetail | null {
  const raw = headers?.get?.("x-scopebond-evidence-detail")?.trim().toLowerCase() ?? "";
  return raw === "full" ? "full" : raw === "standard" || raw === "minimal" ? "standard" : null;
}

export function evidenceDetail(dir: string): EvidenceDetail {
  return readMeta(dir).evidence_detail === "standard" ? "standard" : "full";
}

/** The exporter's summary settings for this computer, or undefined when it has no receipt key yet (never makes one). */
export function summaryOptions(dir: string): CloudSummaryOptions | undefined {
  const keyFile = join(dir, "attester.key");
  if (!existsSync(keyFile)) return undefined;
  return { detail: () => evidenceDetail(dir), attester: loadOrCreateAttester({ file: keyFile }).attester };
}
