#!/usr/bin/env node
// scopebond-gateway — run the gateway, verify a receipt, or generate an attester key.
//
//   scopebond-gateway <policy.json>            run the gateway (durable by default)
//   scopebond-gateway serve <policy.json>      same, explicit
//   scopebond-gateway verify <receipt.json>    verify a receipt's signature + integrity
//        [--key <pubkey.pem>] [--url <gateway-url>]
//   scopebond-gateway keygen [key-file]        generate + persist an attester key
//
// Env: SCOPEBOND_POLICY, PORT (8787),
//      SCOPEBOND_KEY_FILE (default ./scopebond-attester.key) or SCOPEBOND_ATTESTER_KEY (PKCS8 PEM),
//      SCOPEBOND_DB (default ./scopebond.db) — set SCOPEBOND_RECEIPTS_FILE to force JSONL.

import { serve } from "@hono/node-server";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createGateway } from "./index.js";
import { attesterFromPrivateKeyPem, verifyReceipt } from "./receipts.js";
import type { Attester } from "./receipts.js";
import { loadOrCreateAttester } from "./node-keys.js";
import { openReceiptStore } from "./node-stores.js";
import { sendStartupTelemetry, telemetryEnabled } from "./telemetry.js";

const GATEWAY_VERSION: string = (() => {
  try { return (createRequire(import.meta.url)("../package.json") as { version: string }).version; }
  catch { return "0.0.0"; }
})();

function fail(msg: string): never { console.error(msg); process.exit(1); }

/** A stable, anonymous install id for telemetry — a random UUID persisted to
 *  ~/.scopebond/telemetry-id. No PII; used only to de-duplicate installs. */
function anonInstallId(): { id: string; firstRun: boolean } {
  const file = join(homedir(), ".scopebond", "telemetry-id");
  try {
    if (existsSync(file)) return { id: readFileSync(file, "utf8").trim(), firstRun: false };
    const id = randomUUID();
    mkdirSync(join(homedir(), ".scopebond"), { recursive: true });
    writeFileSync(file, id, { mode: 0o600 });
    return { id, firstRun: true };
  } catch {
    return { id: randomUUID(), firstRun: true };
  }
}
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function resolveAttester(): { attester: Attester; source: string } {
  const inlinePem = process.env.SCOPEBOND_ATTESTER_KEY;
  if (inlinePem) return { attester: attesterFromPrivateKeyPem(inlinePem), source: "env SCOPEBOND_ATTESTER_KEY" };
  const file = process.env.SCOPEBOND_KEY_FILE ?? "scopebond-attester.key";
  const { attester, created } = loadOrCreateAttester({ file });
  return { attester, source: `${file}${created ? " (generated)" : ""}` };
}

function cmdServe(policyPath: string | undefined): void {
  if (!policyPath) fail("usage: scopebond-gateway <policy.json>   (or set SCOPEBOND_POLICY)");
  const policy = JSON.parse(readFileSync(policyPath as string, "utf8"));
  const { attester, source } = resolveAttester();
  const receiptsFile = process.env.SCOPEBOND_RECEIPTS_FILE;
  const { store, kind, path } = openReceiptStore(
    receiptsFile ? { file: receiptsFile } : { db: process.env.SCOPEBOND_DB ?? "scopebond.db" },
  );

  const { app, policyHash } = createGateway({ policy, attester, store });
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port });

  console.log(`scopebond-gateway listening on :${port}`);
  console.log(`  policy    ${policyPath} (hash ${policyHash.slice(0, 12)}…)`);
  console.log(`  attester  ${attester.kid}  [${source}]`);
  console.log(`  receipts  ${kind}: ${path} (durable)`);
  console.log(`  routes    POST /v1/evaluate · POST /mcp · POST /v1/kill · POST /v1/resume`);
  console.log(`            GET /v1/receipts · GET /v1/status · GET /v1/attester · GET /.well-known/jwks.json`);

  // Anonymous, opt-out startup telemetry (no PII; disabled unless configured).
  if (telemetryEnabled()) {
    const { id, firstRun } = anonInstallId();
    if (firstRun) {
      console.log(`  telemetry anonymous usage stats are on (no PII, no policy contents).`);
      console.log(`            opt out: SCOPEBOND_TELEMETRY=0 · details: TELEMETRY.md`);
    }
    const clauses = (policy.clauses ?? []) as Array<{ type?: string }>;
    const clauseTypes = [...new Set(clauses.map((c) => c.type).filter(Boolean) as string[])].sort();
    void sendStartupTelemetry({
      gatewayVersion: GATEWAY_VERSION,
      clauseTypes,
      clauseCount: clauses.length,
      storeKind: kind,
      nodeVersion: process.version,
      platform: process.platform,
    }, id);
  }
}

async function cmdVerify(args: string[]): Promise<void> {
  const receiptPath = args[0];
  if (!receiptPath) fail("usage: scopebond-gateway verify <receipt.json> [--key <pubkey.pem>] [--url <gateway-url>]");
  const parsed = JSON.parse(readFileSync(receiptPath as string, "utf8"));
  // Accept a bare SignedReceipt, or an /v1/evaluate response ({ receipt }).
  const receipt = parsed?.payload ? parsed : parsed?.receipt;
  if (!receipt?.payload) fail("input is not a scopebond:receipt (no .payload, and no .receipt wrapper)");

  let pem = flag(args, "--key") ? readFileSync(flag(args, "--key") as string, "utf8") : undefined;
  const url = flag(args, "--url");
  if (!pem && url) {
    const res = await fetch(new URL("/v1/attester", url));
    pem = ((await res.json()) as { public_key_pem: string }).public_key_pem;
  }
  if (!pem) fail("no attester public key — pass --key <pubkey.pem> or --url <gateway-url>");

  const v = verifyReceipt(receipt, pem as string);
  console.log(`signature_valid   ${v.signature_valid}`);
  console.log(`intent_hash_valid ${v.intent_hash_valid}`);
  console.log(v.valid ? "✔ receipt is valid" : "✘ receipt is NOT valid");
  process.exit(v.valid ? 0 : 2);
}

function cmdKeygen(args: string[]): void {
  const file = args[0] ?? process.env.SCOPEBOND_KEY_FILE ?? "scopebond-attester.key";
  const { attester, created } = loadOrCreateAttester({ file });
  console.log(`${created ? "generated" : "exists"}: ${file}`);
  console.log(`kid: ${attester.kid}`);
  const pubOut = flag(args, "--out");
  if (pubOut) { writeFileSync(pubOut as string, attester.publicKeyPem); console.log(`public key -> ${pubOut}`); }
  else console.log(attester.publicKeyPem.trim());
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "verify") { await cmdVerify(rest); }
else if (cmd === "keygen") { cmdKeygen(rest); }
else if (cmd === "serve") { cmdServe(rest[0]); }
else { cmdServe(cmd ?? process.env.SCOPEBOND_POLICY); } // default: treat first arg as the policy path
