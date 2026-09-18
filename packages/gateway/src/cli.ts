#!/usr/bin/env node
// scopebond-gateway — run the gateway, verify a receipt, or generate an attester key.
//
//   scopebond-gateway init [--force]           scaffold agent key + principal-keys.json + policy
//   scopebond-gateway <policy.json>            run the gateway (durable by default)
//   scopebond-gateway serve <policy.json>      same, explicit
//   scopebond-gateway verify <receipt.json>    verify a receipt's signature + integrity
//        [--key <pubkey.pem>] [--url <gateway-url>]
//   scopebond-gateway keygen [key-file]        generate + persist an attester key
//   scopebond-gateway enroll <cloud-url> <enrollment.json>
//                                               prove key possession and print config
//
// Env: SCOPEBOND_POLICY, PORT (8787),
//      SCOPEBOND_KEY_FILE (default ./scopebond-attester.key) or SCOPEBOND_ATTESTER_KEY (PKCS8 PEM),
//      SCOPEBOND_DB (default ./scopebond.db) — set SCOPEBOND_RECEIPTS_FILE to force JSONL,
//      SCOPEBOND_CLOUD_URL + SCOPEBOND_CLOUD_CREDENTIAL for durable hosted export.

import { serve } from "@hono/node-server";
import { readFileSync, writeFileSync, watch, existsSync } from "node:fs";
import { createPublicKey, randomBytes } from "node:crypto";
import { createGateway, createCloudExporter, withCloudExporter, StaticPrincipalKeyRegistry, deriveKid, completeCloudEnrollment } from "./index.js";
import type { CloudExporter } from "./index.js";
import type { GatewayAuthentication, PrincipalKeyRecord, PrincipalPurpose } from "./index.js";
import { attesterFromPrivateKeyPem, verifyReceipt } from "./receipts.js";
import type { Attester } from "./receipts.js";
import { loadOrCreateAttester } from "./node-keys.js";
import { openReceiptStore, SqliteCloudOutbox } from "./node-stores.js";

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
  const cloudCredential = process.env.SCOPEBOND_CLOUD_CREDENTIAL;
  if ((cloudUrl && !cloudCredential) || (!cloudUrl && cloudCredential)) {
    fail("SCOPEBOND_CLOUD_URL and SCOPEBOND_CLOUD_CREDENTIAL must be configured together");
  }
  if (cloudUrl && cloudCredential) {
    let outbox: SqliteCloudOutbox;
    const outboxPath = process.env.SCOPEBOND_CLOUD_OUTBOX ?? `${path}.cloud-outbox.db`;
    try {
      outbox = new SqliteCloudOutbox(outboxPath, {
        maxPending: Number(process.env.SCOPEBOND_CLOUD_MAX_PENDING ?? 10_000),
        maxBytes: Number(process.env.SCOPEBOND_CLOUD_MAX_BYTES ?? 64 * 1024 * 1024),
        maxAgeMs: Number(process.env.SCOPEBOND_CLOUD_MAX_AGE_MS ?? 7 * 24 * 60 * 60 * 1000),
        maxGapRecords: Number(process.env.SCOPEBOND_CLOUD_MAX_GAPS ?? 10_000),
      });
    } catch (error) {
      fail(`durable Cloud outbox could not open: ${error instanceof Error ? error.message : String(error)}`);
    }
    exporter = createCloudExporter({
      url: cloudUrl, credential: cloudCredential, outbox,
      flushMs: Number(process.env.SCOPEBOND_CLOUD_FLUSH_MS ?? 15000),
      onError: (e) => console.error(`  cloud export error: ${(e as Error).message}`),
      onGap: (gap) => console.error(`  cloud delivery gap: ${gap.reason}${gap.id ? ` (${gap.id})` : ""}`),
    });
    store = withCloudExporter(baseStore, exporter);
  }

  const authentication = resolveAuthentication();
  const controlToken = process.env.SCOPEBOND_CONTROL_TOKEN;
  const gateway = createGateway({
    policy, attester, store, authentication,
    ...(controlToken ? { control: { bearerToken: controlToken } } : {}),
  });
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: gateway.app.fetch, port });

  console.log(`scopebond-gateway listening on :${port}`);
  console.log(`  policy    ${policyPath} (hash ${gateway.policyHash.slice(0, 12)}…)`);
  console.log(`  attester  ${attester.kid}  [${source}]`);
  console.log(`  receipts  ${kind}: ${path} (durable)`);
  console.log(`  controls  ${controlToken ? "bearer protected" : "disabled (set SCOPEBOND_CONTROL_TOKEN)"}`);
  console.log(`  routes    POST /v1/evaluate · /mcp · /v1/kill · /v1/resume · /v1/anchor`);
  console.log(`            GET /v1/receipts · /v1/status · /v1/attester · /.well-known/jwks.json · /v1/anchors[/latest|/proof]`);

  if (exporter) {
    console.log(`  cloud     exporting receipts to ${cloudUrl} (${exporter.pending()} pending)`);
    // Backfill existing receipts once (Cloud dedupes on ingest, so it's idempotent).
    if ((process.env.SCOPEBOND_CLOUD_BACKFILL ?? "1") !== "0") {
      Promise.resolve(baseStore.list()).then((all) => { for (const r of all) exporter!.enqueue(r); }).catch(() => {});
    }
    const shutdown = () => { void exporter!.flush().finally(() => { exporter!.stop(); process.exit(0); }); };
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

async function cmdEnroll(args: string[]): Promise<void> {
  const [url, bundlePath] = args;
  if (!url || !bundlePath) fail("usage: scopebond-gateway enroll <cloud-url> <enrollment.json>");
  let bundle: { enrollment_token: string; proof_canonical: string };
  try { bundle = JSON.parse(readFileSync(bundlePath, "utf8")); }
  catch (error) { fail(`could not read enrollment bundle: ${(error as Error).message}`); }
  const { attester, source } = resolveAttester();
  try {
    const result = await completeCloudEnrollment({ url, bundle, attester });
    console.log(`gateway enrolled: ${result.gateway_id}`);
    console.log(`attester: ${result.attester_kid} [${source}]`);
    console.log(`credential expires: ${result.expires_at}`);
    console.log("Set these only in the gateway environment:");
    console.log(`SCOPEBOND_CLOUD_URL=${new URL(url).origin}`);
    console.log(`SCOPEBOND_CLOUD_CREDENTIAL=${result.credential}`);
  } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
}

// Scaffold a working project: an agent signing key, a key registry that trusts it,
// and a starter policy bound to that key — the gap between the ephemeral-key demo
// and a real agent submitting signed actions. Nothing here is a secret at rest
// except the generated control token, which is printed once and never written.
function cmdInit(args: string[]): void {
  const force = args.includes("--force");
  const keyFile = "scopebond-agent.key";
  const keysRegistry = "principal-keys.json";
  const policyFile = "scopebond.policy.json";

  // Refuse before writing (or generating a key): a run that will not overwrite must
  // leave the directory exactly as it found it, never a stray agent key behind.
  if (existsSync(keysRegistry) && !force) fail(`${keysRegistry} already exists (use --force to overwrite)`);
  if (existsSync(policyFile) && !force) fail(`${policyFile} already exists (use --force to overwrite)`);

  // 1. The agent's signing key (Ed25519, persisted PKCS8) — reused across restarts.
  const existed = existsSync(keyFile);
  const { attester: agent } = loadOrCreateAttester({ file: keyFile });

  // 2. Register the agent's public key so the gateway accepts its signatures.
  writeFileSync(keysRegistry, JSON.stringify(
    [{ public_key_pem: agent.publicKeyPem, purposes: ["agent"], status: "active" }], null, 2) + "\n");

  // 3. A starter policy bound to this agent's key. Edit the limits to taste.
  const policy = {
    vocabulary_version: "1.0",
    assets: { USDC: { decimals: 2 } },
    policy_id: "my-agent",
    version: 1,
    clauses: [
      { id: "tx-cap", type: "spend_limit", mode: "enforce", asset: "USDC", max_per_action: 1000000, description: "Enforced: no single payment above $10,000" },
      { id: "daily", type: "spend_limit", mode: "monitor", asset: "USDC", max_per_window: 5000000, window: "P1D", scope: "principal", description: "Monitored: no more than $50,000/day" },
      { id: "keys", type: "key_policy", active_keys: [agent.kid], description: "Only this agent key may sign" },
    ],
  };
  writeFileSync(policyFile, JSON.stringify(policy, null, 2) + "\n");

  // 4. A control token for the kill switch / control routes — printed once, kept out of files.
  const controlToken = randomBytes(24).toString("base64url");

  console.log("Scopebond project scaffolded:");
  console.log(`  ${keyFile}        ${existed ? "(existing key reused)" : "(new agent signing key)"}`);
  console.log(`  ${keysRegistry}   (registers the agent public key · kid ${agent.kid})`);
  console.log(`  ${policyFile}  (starter policy — edit the limits)`);
  console.log("");
  console.log("1) Start the gateway (keep the control token secret; do not commit it):");
  console.log(`     SCOPEBOND_PRINCIPAL_KEYS_FILE=${keysRegistry} \\`);
  console.log(`     SCOPEBOND_CONTROL_TOKEN=${controlToken} \\`);
  console.log(`     npx @scopebond/gateway ${policyFile}`);
  console.log("");
  console.log("2) From your agent, sign an action and submit it:");
  console.log(`     import { readFileSync } from "node:fs";`);
  console.log(`     import { createSigner, submit } from "@scopebond/sdk";`);
  console.log(`     const agent = createSigner({ privateKeyPem: readFileSync("${keyFile}", "utf8") });`);
  console.log(`     const signed = agent.sign({ action_type: "payout.create", asset: "USDC", amount: 500000 });`);
  console.log(`     console.log(await submit("http://localhost:8787", signed)); // { allowed, reason, receipt }`);
  console.log("");
  console.log("3) Verify a saved receipt against the gateway's published key:");
  console.log(`     npx @scopebond/gateway verify ./receipt.json --url http://localhost:8787`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "verify") { await cmdVerify(rest); }
else if (cmd === "keygen") { cmdKeygen(rest); }
else if (cmd === "enroll") { await cmdEnroll(rest); }
else if (cmd === "init") { cmdInit(rest); }
else if (cmd === "serve") { cmdServe(rest[0]); }
else { cmdServe(cmd ?? process.env.SCOPEBOND_POLICY); } // default: treat first arg as the policy path
