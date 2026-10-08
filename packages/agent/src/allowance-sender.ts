// D144 (SB411): the agent tells the workspace about allowances a person made on this computer and the requests they sent to
// an admin. Each record is signed by the key this computer enrolled with (the same key that countersigns its receipts), so
// the workspace can show it was made here. Sent once; one the workspace refuses for good (400) is not sent again; one it
// could not take (offline, 5xx) waits for the next cycle. A workspace without these calls (404) leaves them on the computer.
// Each signature covers a domain line and the canonical record, so neither can pass as a receipt signed by the same key. The
// files are re-read before each write and only what this send changed is applied, so a hook writing meanwhile loses nothing.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "@scopebond/gateway";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { readAllowances, readRequests, writeAllowances, writeRequests, type HookConnection } from "@scopebond/hook";

export const ALLOWANCE_DOMAIN = "scopebond:allowance/v1\n";
export const REQUEST_DOMAIN = "scopebond:request/v1\n";

export async function sendAllowancesAndRequests(dir: string, connection: Pick<HookConnection, "url" | "credential">, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<{ allowances: number; requests: number }> {
  const sent = { allowances: 0, requests: 0 };
  const keyFile = join(dir, "attester.key");
  if (!existsSync(keyFile)) return sent; // never makes a key: an unenrolled computer has nothing to send
  const { attester } = loadOrCreateAttester({ file: keyFile });
  const post = async (path: string, record: Record<string, unknown>, domain: string): Promise<"sent" | "refused" | "later"> => {
    try {
      const body = { record, kid: attester.kid, signature: await attester.sign(domain + canonical(record)) };
      const res = await fetchImpl(new URL(path, connection.url).toString(), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${connection.credential}`, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      if (res.ok) return "sent";
      return res.status === 400 || res.status === 409 ? "refused" : "later";
    } catch { return "later"; }
  };

  const at = new Date(now).toISOString();
  const allowanceOutcomes = new Map<string, "sent" | "refused">();
  for (const a of readAllowances(dir)) {
    if (a.created_by !== "person" || a.sent_at) continue;
    const { sent_at: _sent, uses: _uses, ...record } = a;
    const outcome = await post("/v1/allowances", record, ALLOWANCE_DOMAIN);
    if (outcome !== "later") allowanceOutcomes.set(a.id, outcome);
  }
  if (allowanceOutcomes.size) {
    // Applied to the file as it is now (the hook may have counted a use or added an allowance while this was sending).
    writeAllowances(dir, readAllowances(dir).map((a) => {
      const outcome = allowanceOutcomes.get(a.id);
      if (!outcome || a.sent_at) return a;
      if (outcome === "sent") { sent.allowances += 1; const { reason: _text, ...rest } = a; return { ...rest, sent_at: at }; } // the workspace keeps the text
      return { ...a, sent_at: at };
    }), now);
  }

  const requestOutcomes = new Map<string, "sent" | "refused">();
  for (const r of readRequests(dir)) {
    if (r.sent_at) continue;
    const { sent_at: _sent, ...record } = r;
    const outcome = await post("/v1/requests", record, REQUEST_DOMAIN);
    if (outcome !== "later") requestOutcomes.set(r.id, outcome);
  }
  if (requestOutcomes.size) {
    writeRequests(dir, readRequests(dir).map((r) => {
      const outcome = requestOutcomes.get(r.id);
      if (!outcome || r.sent_at) return r;
      if (outcome === "sent") sent.requests += 1;
      return { ...r, sent_at: at };
    }), now);
  }
  return sent;
}
