// A stand-in Scopebond workspace for tests: the device-code sign-in, enrollment, record
// delivery, observations, managed rules, self-check and client-version routes a computer
// talks to, with a test-only control surface (approve a code, read what arrived) and fault
// injection (401, 409, 429, 500, a slow answer, a dropped connection) per route.
// Dependency-free: node built-ins only.

import http from "node:http";
import { createHash, createPublicKey, randomBytes } from "node:crypto";

/** The workspace's key id for an Ed25519 public key: the derivation the gateway uses. */
export function kidForPem(pem: string): string {
  const jwk = createPublicKey(pem).export({ format: "jwk" }) as { crv?: string; kty?: string; x?: string };
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return "key:" + createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** One injected failure for a route. `status` answers with that HTTP status (and `code` as the
 *  machine-readable refusal); `delayMs` answers late; `drop` closes the connection with no answer.
 *  `times` limits how many requests it applies to (default: every request until cleared). */
export interface Fault { status?: number; code?: string; delayMs?: number; drop?: boolean; times?: number; retryAfter?: number }

export type FakeRoute = "device/code" | "device/token" | "enroll" | "ingest" | "observations" | "policy" | "self-check" | "client-version";

export interface FakeCloudState {
  code_requests: Array<{ client_name: string | null; harness: string | null }>;
  enrolled: number;
  ingested: number;
  ingested_results: Array<string | null>;
  observations: number;
  self_checks: Array<{ failed: string[]; hook_version: string | null; agent_version: string | null }>;
  policy_polls: number;
  version_polls: number;
  approved_codes: string[];
  pending_codes: string[];
  faults_applied: Array<{ route: FakeRoute; what: string }>;
}

export interface FakeCloud {
  url: string;
  state(): FakeCloudState;
  /** Every receipt delivered to /v1/ingest, in order. */
  receipts: unknown[];
  /** Approve a pending code, as a person would on the approval page (the newest if none is named). */
  approve(userCode?: string): boolean;
  /** Fail the next requests to a route (see Fault). */
  fault(route: FakeRoute, fault: Fault): void;
  clearFaults(): void;
  /** What the client version route answers (404 until set). */
  setClientVersion(value: { policy: "recommended" | "hold"; hook: string | null; agent: string | null } | null): void;
  close(): Promise<void>;
}

export interface FakeCloudOptions { host?: string; port?: number; autoApprove?: boolean }

const LETTERS = "BCDFGHJKLMNPQRSTVWXZ";
const newUserCode = () => Array.from(randomBytes(8), (b, i) => (i === 4 ? "-" : "") + LETTERS[b % LETTERS.length]).join("");

interface Code { user_code: string; approved: boolean; consumed: boolean; polled: boolean; enrollment_token?: string }

export function startFakeCloud(options: FakeCloudOptions = {}): Promise<FakeCloud> {
  const { host = "127.0.0.1", port = 0, autoApprove = false } = options;
  const codes = new Map<string, Code>();
  const credentials = new Set<string>();
  const faults = new Map<FakeRoute, Fault>();
  let clientVersion: { policy: "recommended" | "hold"; hook: string | null; agent: string | null } | null = null;
  const seen = {
    codeRequests: [] as FakeCloudState["code_requests"], enrolled: 0, ingested: [] as unknown[], observations: 0,
    selfChecks: [] as FakeCloudState["self_checks"], policyPolls: 0, versionPolls: 0, approved: [] as string[],
    faultsApplied: [] as FakeCloudState["faults_applied"],
  };

  const routeOf = (path: string): FakeRoute | null => {
    const name = path.replace(/^\/v1\//, "");
    return (["device/code", "device/token", "enroll", "ingest", "observations", "policy", "self-check", "client-version"] as const).find((r) => r === name) ?? null;
  };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8"); // decodes a character split across chunks whole
    req.on("data", (c: string) => { raw += c; });
    req.on("end", () => {
      const json = (status: number, value?: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(value === undefined ? "" : JSON.stringify(value));
      };
      const url = new URL(req.url ?? "/", "http://fake");
      const route = routeOf(url.pathname);
      const fault = route ? faults.get(route) : undefined;
      if (route && fault) {
        if (fault.times !== undefined) { fault.times -= 1; if (fault.times <= 0) faults.delete(route); }
        if (fault.drop) { seen.faultsApplied.push({ route, what: "drop" }); req.socket.destroy(); return; }
        if (fault.status) {
          seen.faultsApplied.push({ route, what: String(fault.status) });
          const send = () => json(fault.status!, { error: fault.code ?? "injected", code: fault.code ?? "injected" }, fault.retryAfter ? { "retry-after": String(fault.retryAfter) } : {});
          if (fault.delayMs) setTimeout(send, fault.delayMs); else send();
          return;
        }
        if (fault.delayMs) {
          seen.faultsApplied.push({ route, what: `slow ${fault.delayMs}ms` });
          setTimeout(() => handle(url, raw, req, json, res), fault.delayMs);
          return;
        }
      }
      handle(url, raw, req, json, res);
    });
  });

  function handle(url: URL, raw: string, req: http.IncomingMessage, json: (status: number, value?: unknown) => void, res: http.ServerResponse): void {
    let body: Record<string, unknown> = {};
    try { body = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { return json(400, { error: "invalid_json" }); }
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    const authed = () => credentials.has(bearer);
    const origin = `http://${req.headers.host}`;
    const path = url.pathname;

    if (path === "/healthz") return json(200, { ok: true });
    if (path === "/v1/device/code" && req.method === "POST") {
      seen.codeRequests.push({ client_name: typeof body.client_name === "string" ? body.client_name : null, harness: typeof body.harness === "string" ? body.harness : null });
      const device_code = randomBytes(32).toString("base64url");
      const user_code = newUserCode();
      codes.set(device_code, { user_code, approved: false, consumed: false, polled: false });
      return json(200, {
        device_code, user_code, verification_uri: `${origin}/app/device`,
        verification_uri_complete: `${origin}/app/device?code=${user_code}`, expires_in: 600, interval: 1,
      });
    }
    if (path === "/v1/device/token" && req.method === "POST") {
      const entry = codes.get(typeof body.device_code === "string" ? body.device_code : "");
      if (!entry || entry.consumed) return json(400, { error: "expired_token" });
      if (!entry.approved && autoApprove && entry.polled) { entry.approved = true; seen.approved.push(entry.user_code); }
      entry.polled = true;
      if (!entry.approved) return json(400, { error: "authorization_pending" });
      entry.consumed = true;
      entry.enrollment_token = "sbe_" + randomBytes(12).toString("hex");
      return json(200, {
        enrollment: {
          enrollment_token: entry.enrollment_token,
          proof_canonical: JSON.stringify({ challenge: randomBytes(8).toString("hex"), enrollment_id: "enr-1", type: "scopebond:gateway-enrollment", version: 1 }),
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        },
        organization_id: "org-fake", environment_id: "env-fake", agent_id: "agent-fake",
      });
    }
    if (path === "/v1/enroll" && req.method === "POST") {
      const known = [...codes.values()].some((c) => c.enrollment_token && c.enrollment_token === body.enrollment_token) || (typeof body.enrollment_token === "string" && body.enrollment_token.startsWith("sbe_fake"));
      if (!known || typeof body.public_key_pem !== "string") return json(400, { error: "invalid_enrollment" });
      const credential = "sbm_" + randomBytes(16).toString("hex");
      credentials.add(credential);
      seen.enrolled += 1;
      const attester_kid = kidForPem(body.public_key_pem);
      const agent_kid = typeof body.agent_public_key_pem === "string" ? kidForPem(body.agent_public_key_pem) : undefined;
      return json(200, {
        credential_id: `cred-${seen.enrolled}`, credential, organization_id: "org-fake", environment_id: "env-fake",
        gateway_id: `gw-${seen.enrolled}`, attester_kid, ...(agent_kid ? { agent_kid } : {}),
        scopes: ["receipt:ingest"], expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      });
    }
    if (path === "/v1/ingest" && req.method === "POST") {
      if (!authed()) return json(401, { error: "unauthorized", code: "credential_unknown" });
      const receipts = Array.isArray(body.receipts) ? body.receipts : [];
      seen.ingested.push(...receipts);
      return json(200, { accepted: receipts.length });
    }
    if (path === "/v1/observations" && req.method === "POST") {
      if (!authed()) return json(401, { error: "unauthorized" });
      const items = Array.isArray(body.observations) ? body.observations : [];
      seen.observations += items.length;
      return json(200, { accepted: items.length, results: items.map(() => ({ status: "accepted" })) });
    }
    if (path === "/v1/policy" && req.method === "GET") {
      if (!authed()) return json(401, { error: "unauthorized" });
      seen.policyPolls += 1;
      res.writeHead(204); res.end(); return; // no managed rules: the local policy stays
    }
    if (path === "/v1/self-check" && req.method === "POST") {
      if (!authed()) return json(401, { error: "unauthorized" });
      const checks = Array.isArray(body.checks) ? body.checks as Array<{ id?: unknown; ok?: unknown }> : [];
      const failed = checks.filter((c) => c.ok !== true).map((c) => String(c.id));
      seen.selfChecks.push({ failed, hook_version: typeof body.hook_version === "string" ? body.hook_version : null, agent_version: typeof body.agent_version === "string" ? body.agent_version : null });
      return json(200, { ok: failed.length === 0, signature_verified: true, failed });
    }
    // The optional summary a workspace gives a computer's tray (names, links, Review count); links stay on this origin.
    if (path === "/v1/computer/summary" && req.method === "GET") {
      if (!authed()) return json(401, { error: "unauthorized" });
      const origin = `http://${req.headers.host ?? "127.0.0.1"}`;
      return json(200, { workspace_name: "Fake workspace", environment_name: "Test", computer_name: null, computer_url: `${origin}/app/connections/fake`, review_url: `${origin}/app/findings`, open_reviews: 0, stage: "reporting" });
    }
    if (path === "/v1/client-version" && req.method === "GET") {
      seen.versionPolls += 1;
      return clientVersion ? json(200, clientVersion) : json(404, { error: "not_found" });
    }
    if (path === "/__test/approve" && req.method === "POST") {
      return approve(typeof body.user_code === "string" ? body.user_code : undefined) ? json(200, { approved: true }) : json(404, { error: "no_pending_code" });
    }
    if (path === "/__test/state" && req.method === "GET") return json(200, state());
    json(404, { error: "not_found" });
  }

  function approve(userCode?: string): boolean {
    const entry = [...codes.values()].reverse().find((c) => !c.approved && !c.consumed && (!userCode || c.user_code === userCode));
    if (!entry) return false;
    entry.approved = true;
    seen.approved.push(entry.user_code);
    return true;
  }

  const state = (): FakeCloudState => ({
    code_requests: seen.codeRequests, enrolled: seen.enrolled, ingested: seen.ingested.length,
    ingested_results: seen.ingested.map((r) => ((r as { payload?: { realtime_result?: string } })?.payload?.realtime_result ?? null)),
    observations: seen.observations, self_checks: seen.selfChecks, policy_polls: seen.policyPolls, version_polls: seen.versionPolls,
    approved_codes: seen.approved, pending_codes: [...codes.values()].filter((c) => !c.approved && !c.consumed).map((c) => c.user_code),
    faults_applied: seen.faultsApplied,
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const url = `http://${host}:${typeof address === "object" && address ? address.port : port}`;
      resolve({
        url, state, receipts: seen.ingested, approve,
        fault: (route, fault) => { faults.set(route, { ...fault }); },
        clearFaults: () => faults.clear(),
        setClientVersion: (value) => { clientVersion = value; },
        close: () => new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
      });
    });
  });
}
