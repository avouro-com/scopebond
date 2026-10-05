// A stand-in Scopebond workspace for the install and journey checks: the device-code login,
// enrollment, record delivery, managed rules, self-check and client-version routes a computer
// talks to, plus a test-only control route that approves a code the way a person would in the
// browser. Dependency-free (node: built-ins only), so it runs from a plain checkout.
//
// In process:   const cloud = await startFakeCloud(); … cloud.state(); cloud.close();
// As a process: node fake-cloud.mjs --url-file <path> [--auto-approve]
//               (writes its URL there, runs until killed; --auto-approve approves each code on its
//               second poll, as a person who opened the page would, and lists it in approved_codes)
//
// Test control (never part of the real API):
//   POST /__test/approve {"user_code": "…"}   approve a pending code (the newest if omitted)
//   GET  /__test/state                        what the workspace has seen so far

import http from "node:http";
import { createHash, createPublicKey, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The workspace's key id for an Ed25519 public key: the same derivation the gateway uses. */
export function kidForPem(pem) {
  const jwk = createPublicKey(pem).export({ format: "jwk" });
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return "key:" + createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

const LETTERS = "BCDFGHJKLMNPQRSTVWXZ";
const userCode = () => Array.from(randomBytes(8), (b, i) => (i === 4 ? "-" : "") + LETTERS[b % LETTERS.length]).join("");

export function startFakeCloud({ host = "127.0.0.1", port = 0, autoApprove = false } = {}) {
  const codes = new Map(); // device_code -> { user_code, client_name, harness, approved, consumed }
  const seen = {
    codeRequests: [], enrolled: [], ingested: [], observations: 0, selfChecks: [], policyPolls: 0,
    versionPolls: 0, credentials: new Set(), approved: [],
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const json = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(value === undefined ? "" : JSON.stringify(value));
      };
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return json(400, { error: "invalid_json" }); }
      const url = new URL(req.url, "http://fake");
      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      const authed = () => seen.credentials.has(bearer);
      const origin = `http://${req.headers.host}`;

      if (url.pathname === "/healthz") return json(200, { ok: true });

      if (url.pathname === "/v1/device/code" && req.method === "POST") {
        seen.codeRequests.push({ client_name: body.client_name ?? null, harness: body.harness ?? null });
        const device_code = randomBytes(32).toString("base64url");
        const user_code = userCode();
        codes.set(device_code, { user_code, approved: false, consumed: false });
        return json(200, {
          device_code, user_code,
          verification_uri: `${origin}/app/device`,
          verification_uri_complete: `${origin}/app/device?code=${user_code}`,
          expires_in: 600, interval: 1,
        });
      }

      if (url.pathname === "/v1/device/token" && req.method === "POST") {
        const entry = codes.get(String(body.device_code ?? ""));
        if (!entry || entry.consumed) return json(400, { error: "expired_token" });
        if (!entry.approved && autoApprove && entry.polled) { entry.approved = true; seen.approved.push(entry.user_code); }
        entry.polled = true;
        if (!entry.approved) return json(400, { error: "authorization_pending" });
        entry.consumed = true;
        const enrollment_token = "sbe_" + randomBytes(12).toString("hex");
        entry.enrollment_token = enrollment_token;
        return json(200, {
          enrollment: {
            enrollment_token,
            proof_canonical: JSON.stringify({ challenge: randomBytes(8).toString("hex"), enrollment_id: "enr-1", type: "scopebond:gateway-enrollment", version: 1 }),
            expires_at: new Date(Date.now() + 600_000).toISOString(),
          },
          organization_id: "org-fake", environment_id: "env-fake", agent_id: "agent-fake",
        });
      }

      if (url.pathname === "/v1/enroll" && req.method === "POST") {
        const known = [...codes.values()].some((c) => c.enrollment_token && c.enrollment_token === body.enrollment_token);
        if (!known || typeof body.public_key_pem !== "string") return json(400, { error: "invalid_enrollment" });
        const credential = "sbm_" + randomBytes(16).toString("hex");
        seen.credentials.add(credential);
        const attester_kid = kidForPem(body.public_key_pem);
        const agent_kid = typeof body.agent_public_key_pem === "string" ? kidForPem(body.agent_public_key_pem) : undefined;
        seen.enrolled.push({ attester_kid, agent_kid });
        return json(200, {
          credential_id: `cred-${seen.enrolled.length}`, credential,
          organization_id: "org-fake", environment_id: "env-fake", gateway_id: `gw-${seen.enrolled.length}`,
          attester_kid, ...(agent_kid ? { agent_kid } : {}),
          scopes: ["receipt:ingest"], expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString(),
        });
      }

      if (url.pathname === "/v1/ingest" && req.method === "POST") {
        if (!authed()) return json(401, { error: "unauthorized", code: "credential_unknown" });
        const receipts = Array.isArray(body.receipts) ? body.receipts : [];
        for (const r of receipts) seen.ingested.push(r);
        return json(200, { accepted: receipts.length });
      }
      if (url.pathname === "/v1/observations" && req.method === "POST") {
        if (!authed()) return json(401, { error: "unauthorized" });
        const items = Array.isArray(body.observations) ? body.observations : [];
        seen.observations += items.length;
        return json(200, { accepted: items.length, results: items.map(() => ({ status: "accepted" })) });
      }
      if (url.pathname === "/v1/policy" && req.method === "GET") {
        if (!authed()) return json(401, { error: "unauthorized" });
        seen.policyPolls += 1;
        res.writeHead(204); return res.end(); // no managed rules: the local policy stays
      }
      if (url.pathname === "/v1/self-check" && req.method === "POST") {
        if (!authed()) return json(401, { error: "unauthorized" });
        const failed = Array.isArray(body.checks) ? body.checks.filter((c) => !c.ok).map((c) => c.id) : [];
        seen.selfChecks.push({ failed, hook_version: body.hook_version ?? null, agent_version: body.agent_version ?? null });
        return json(200, { ok: failed.length === 0, signature_verified: true, failed });
      }
      if (url.pathname === "/v1/client-version" && req.method === "GET") {
        seen.versionPolls += 1;
        return json(404, { error: "not_found" }); // no workspace-held version: the agent changes nothing
      }

      if (url.pathname === "/__test/approve" && req.method === "POST") {
        const pending = [...codes.values()].filter((c) => !c.approved && !c.consumed);
        const entry = body.user_code ? pending.find((c) => c.user_code === body.user_code) : pending.at(-1);
        if (!entry) return json(404, { error: "no_pending_code" });
        entry.approved = true;
        seen.approved.push(entry.user_code);
        return json(200, { approved: entry.user_code });
      }
      if (url.pathname === "/__test/state" && req.method === "GET") return json(200, state());

      json(404, { error: "not_found" });
    });
  });
  const state = () => ({
    code_requests: seen.codeRequests, enrolled: seen.enrolled.length, ingested: seen.ingested.length,
    ingested_results: seen.ingested.map((r) => r?.payload?.realtime_result ?? null),
    observations: seen.observations, self_checks: seen.selfChecks, policy_polls: seen.policyPolls,
    approved_codes: seen.approved,
    pending_codes: [...codes.values()].filter((c) => !c.approved && !c.consumed).map((c) => c.user_code),
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const url = `http://${host}:${server.address().port}`;
      resolve({
        url, state, receipts: seen.ingested,
        approve: (code) => {
          const entry = [...codes.values()].find((c) => !c.approved && !c.consumed && (!code || c.user_code === code));
          if (!entry) return false;
          entry.approved = true;
          seen.approved.push(entry.user_code);
          return true;
        },
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  const i = process.argv.indexOf("--url-file");
  const cloud = await startFakeCloud({ autoApprove: process.argv.includes("--auto-approve") });
  if (i > 0 && process.argv[i + 1]) writeFileSync(process.argv[i + 1], cloud.url);
  console.log(cloud.url);
}
