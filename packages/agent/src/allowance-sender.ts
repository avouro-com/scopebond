// D144 (SB411): the agent tells the workspace about allowances a person made on this computer and the requests they sent to
// an admin. Each record is signed by the key this computer enrolled with (the same key that countersigns its receipts), so
// the workspace can show it was made here. Sent once; one the workspace refuses for good (400) is not sent again; one it
// could not take (offline, 5xx) waits for the next cycle. A workspace without these calls (404) leaves them on the computer.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "@scopebond/gateway";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { readAllowances, readRequests, writeAllowances, writeRequests, type HookConnection } from "@scopebond/hook";

export async function sendAllowancesAndRequests(dir: string, connection: Pick<HookConnection, "url" | "credential">, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<{ allowances: number; requests: number }> {
  const sent = { allowances: 0, requests: 0 };
  const keyFile = join(dir, "attester.key");
  if (!existsSync(keyFile)) return sent; // never makes a key: an unenrolled computer has nothing to send
  const { attester } = loadOrCreateAttester({ file: keyFile });
  const post = async (path: string, record: Record<string, unknown>): Promise<"sent" | "refused" | "later"> => {
    try {
      const body = { record, kid: attester.kid, signature: await attester.sign(canonical(record)) };
      const res = await fetchImpl(new URL(path, connection.url).toString(), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${connection.credential}`, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      if (res.ok) return "sent";
      return res.status === 400 || res.status === 409 ? "refused" : "later";
    } catch { return "later"; }
  };

  const allowances = readAllowances(dir);
  let changed = false;
  for (const a of allowances) {
    if (a.created_by !== "person" || a.sent_at) continue;
    const { sent_at: _sent, uses: _uses, ...record } = a;
    const outcome = await post("/v1/allowances", record);
    if (outcome === "later") continue;
    a.sent_at = new Date(now).toISOString();
    if (outcome === "sent") { delete a.reason; sent.allowances += 1; } // the workspace keeps the text; the computer keeps the digest
    changed = true;
  }
  if (changed) writeAllowances(dir, allowances, now);

  const requests = readRequests(dir);
  changed = false;
  for (const r of requests) {
    if (r.sent_at) continue;
    const { sent_at: _sent, ...record } = r;
    const outcome = await post("/v1/requests", record);
    if (outcome === "later") continue;
    r.sent_at = new Date(now).toISOString();
    if (outcome === "sent") sent.requests += 1;
    changed = true;
  }
  if (changed) writeRequests(dir, requests, now);
  return sent;
}
