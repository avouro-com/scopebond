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
import { readFileSync, writeFileSync, watch } from "node:fs";
import { createPublicKey } from "node:crypto";
import { createGateway, createCloudExporter, withCloudExporter, StaticPrincipalKeyRegistry, deriveKid } from "./index.js";
import type { CloudExporter } from "./index.js";
import type { GatewayAuthentication, PrincipalKeyRecord, PrincipalPurpose } from "./index.js";
import { attesterFromPrivateKeyPem, verifyReceipt } from "./receipts.js";
import type { Attester } from "./receipts.js";
import { loadOrCreateAttester } from "./node-keys.js";
import { openReceiptStore } from "./node-stores.js";

function fail(msg: string): never { console.error(msg); process.exit(1); }

/** Parse a short duration ("24h", "30m", "1000ms", "0"/"off" → 0). */
function parseDurationMs(s: string): number {
  const t = s.trim().toLowerCase();
  if (t === "" || t === "0" || t === "off" || t === "false") return 0;
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
  if (!m) return 0;
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return Math.round(parseFloat(m[1]) * mult[m[2] ?? "ms"]);
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

function resolveAuthentication(): GatewayAuthentication {
  if (process.env.SCOPEBOND_UNSAFE_ALLOW_UNSIGNED === "1") {
    console.warn("WARNING: unsigned development mode is enabled; do not use this setting in production");
    return { mode: "insecure-development" };
  }
  const file = process.env.SCOPEBOND_PRINCIPAL_KEYS_FILE;
  if (!file) fail("SCOPEBOND_PRINCIPAL_KEYS_FILE is required (or set SCOPEBOND_UNSAFE_ALLOW_UNSIGNED=1 for local simulation only)");
  let source: unknown;
  try { source = JSON.parse(readFileSync(file as string, "utf8")); }
  catch (error) { fail(`could not read principal key registry: ${(error as Error).message}`); }
  if (!Array.isArray(source) || source.length === 0) fail("principal key registry must be a non-empty JSON array");
  const records: PrincipalKeyRecord[] = source.map((item, index) => {
    const row = item as Record<string, unknown>;
    const publicKeyPem = String(row.public_key_pem ?? row.publicKeyPem ?? "");
    const purposes = row.purposes as PrincipalPurpose[];
    if (!publicKeyPem || !Array.isArray(purposes) || purposes.some((purpose) => purpose !== "agent" && purpose !== "approver")) {
      fail(`invalid principal key record at index ${index}`);
    }
    let kid: string;
    try {
      const raw = createPublicKey(publicKeyPem).export({ format: "jwk" }) as Record<string, unknown>;
      kid = deriveKid({ crv: raw.crv, kty: raw.kty, x: raw.x });
    } catch { fail(`principal key record ${index} is not an Ed25519 public key`); }
    return {
      kid, publicKeyPem, purposes, status: row.status === "revoked" ? "revoked" : "active",
      ...(typeof row.not_before === "string" ? { notBefore: row.not_before } : {}),
      ...(typeof row.not_after === "string" ? { notAfter: row.not_after } : {}),
    };
  });
  return { keys: new StaticPrincipalKeyRegistry(records) };
}

function cmdServe(policyPath: string | undefined): void {
  if (!policyPath) fail("usage: scopebond-gateway <policy.json>   (or set SCOPEBOND_POLICY)");
  const policy = JSON.parse(readFileSync(policyPath as string, "utf8"));
  const { attester, source } = resolveAttester();
  const receiptsFile = process.env.SCOPEBOND_RECEIPTS_FILE;
  const { store: baseStore, kind, path } = openReceiptStore(
    receiptsFile ? { file: receiptsFile } : { db: process.env.SCOPEBOND_DB ?? "scopebond.db" },
  );

  // Optional: mirror receipts to Scopebond Cloud (retention + dashboard). Opt-in.
  let exporter: CloudExporter | undefined;
  let store = baseStore;
  const cloudUrl = process.env.SCOPEBOND_CLOUD_URL;
  const cloudKey = process.env.SCOPEBOND_CLOUD_KEY;
  if (cloudUrl && cloudKey) {
    exporter = createCloudExporter({
      url: cloudUrl, apiKey: cloudKey,
      flushMs: Number(process.env.SCOPEBOND_CLOUD_FLUSH_MS ?? 15000),
      onError: (e) => console.error(`  cloud export error: ${(e as Error).message}`),
    });
    store = withCloudExporter(baseStore, exporter);
  }

  const authentication = resolveAuthentication();
  const gateway = createGateway({ policy, attester, store, authentication });
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: gateway.app.fetch, port });

  console.log(`scopebond-gateway listening on :${port}`);
  console.log(`  policy    ${policyPath} (hash ${gateway.policyHash.slice(0, 12)}…)`);
  console.log(`  attester  ${attester.kid}  [${source}]`);
  console.log(`  receipts  ${kind}: ${path} (durable)`);
  console.log(`  routes    POST /v1/evaluate · /mcp · /v1/kill · /v1/resume · /v1/anchor`);
  console.log(`            GET /v1/receipts · /v1/status · /v1/attester · /.well-known/jwks.json · /v1/anchors[/latest|/proof]`);

  if (exporter) {
    console.log(`  cloud     exporting receipts to ${cloudUrl}`);
    // Backfill existing receipts once (Cloud dedupes on ingest, so it's idempotent).
    if ((process.env.SCOPEBOND_CLOUD_BACKFILL ?? "1") !== "0") {
      Promise.resolve(baseStore.list()).then((all) => { for (const r of all) exporter!.enqueue(r); }).catch(() => {});
    }
    const shutdown = () => { void exporter!.flush().finally(() => process.exit(0)); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  // Hot-reload: watch the policy file and swap it in without a restart. Fail safe —
  // a malformed file keeps the current policy. Disable with SCOPEBOND_POLICY_WATCH=0.
  if ((process.env.SCOPEBOND_POLICY_WATCH ?? "1") !== "0") {
    try {
      let debounce: ReturnType<typeof setTimeout> | undefined;
      watch(policyPath as string, () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          try {
            gateway.setPolicy(JSON.parse(readFileSync(policyPath as string, "utf8")));
            console.log(`  policy reloaded (hash ${gateway.policyHash.slice(0, 12)}…)`);
          } catch (e) {
            console.error(`  policy reload failed, keeping current: ${(e as Error).message}`);
          }
        }, 150);
      });
      console.log(`  hot-reload watching ${policyPath}`);
    } catch { /* fs.watch unsupported here — skip */ }
  }

  // Daily anchoring: periodically Merkle-anchor the receipt log (tamper-evidence).
  // SCOPEBOND_ANCHOR_INTERVAL, e.g. 24h (default), 1h, 30m; 0/off disables.
  const anchorMs = parseDurationMs(process.env.SCOPEBOND_ANCHOR_INTERVAL ?? "24h");
  if (anchorMs > 0) {
    const timer = setInterval(() => {
      gateway.anchor()
        .then((a) => console.log(`  anchored #${a.seq}: ${a.count} receipts · root ${a.merkle_root.slice(0, 12)}…`))
        .catch((e) => console.error(`  anchor failed: ${(e as Error).message}`));
    }, anchorMs);
    timer.unref?.();
    console.log(`  anchoring every ${process.env.SCOPEBOND_ANCHOR_INTERVAL ?? "24h"}`);
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
  console.log(`contract_valid    ${v.contract_valid}`);
  console.log(`key_binding_valid ${v.key_binding_valid}`);
  console.log(`action_ref_valid  ${v.intent_hash_valid}`);
  console.log(`policy_ref_valid  ${v.policy_ref_valid}`);
  console.log(`supported_version ${v.supported_version}${v.legacy ? " (legacy)" : ""}`);
  console.log("external_effect_verified false");
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
