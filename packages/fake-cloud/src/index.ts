// A stand-in Scopebond workspace for tests: the device-code sign-in, enrollment, record
// delivery, summaries, observations, managed rules, self-check, uninstall notice and client-version routes a computer
// talks to, with a test-only control surface (approve a code, read what arrived) and fault
// injection (401, 409, 429, 500, a slow answer, a dropped connection) per route.
// Dependency-free: node built-ins only.

import http from "node:http";
import { createHash, createPublicKey, randomBytes, verify as edVerify } from "node:crypto";

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

export type FakeRoute = "device/code" | "device/token" | "enroll" | "repository/enroll" | "ingest" | "observations" | "policy" | "self-check" | "client-version" | "summaries" | "uninstall";

export interface FakeCloudState {
  code_requests: Array<{ client_name: string | null; harness: string | null; machine_id: string | null }>;
  /** The install keys sent to /v1/install/enroll, in order. */
  install_keys: string[];
  /** The `machine_id` each enrollment (/v1/enroll) carried, null when it carried none. */
  enroll_machine_ids: Array<string | null>;
  /** The `x-scopebond-machine-id` header of each check-in (rules check, delivery, summaries, observations), null without one. */
  checkin_machine_ids: Array<{ route: FakeRoute; machine_id: string | null }>;
  enrolled: number;
  /** Repository enrolments (`/v1/repository/enroll`): the repository the hook reported and whether both possession proofs verified. */
  repository_enrollments: Array<{ repository: string | null; proofs_verified: boolean }>;
  ingested: number;
  ingested_results: Array<string | null>;
  observations: number;
  self_checks: Array<{ failed: string[]; hook_version: string | null; agent_version: string | null; tools?: unknown[] | null; mcp_servers?: unknown[] | null }>;
  policy_polls: number;
  version_polls: number;
  /** Summaries delivered to /v1/summaries and held (a summary id sent again is a duplicate, not counted twice). */
  summaries: number;
  /** The routine records those summaries stand for (the sum of their `receipt_count`). */
  summarized_records: number;
  /** Summaries sent again under an id already held, or twice in one request. */
  summary_duplicates: number;
  /** Summaries refused one by one (`rejected` in the answer), whether the request was answered 200 or 400. */
  summary_rejected: number;
  /** The last /v1/summaries body that got past the request checks (answered 200, or 400 with every summary refused), as sent. */
  last_summaries: unknown;
  /** Uninstall notices (/v1/uninstall), whatever their body: `purge` and `hook_version` when the body carries them (null
   *  otherwise), the hook version header, and the body as sent (parsed when it is JSON, else the raw text). */
  uninstalls: Array<{ purge: boolean | null; hook_version: string | null; header_hook_version: string | null; body: unknown }>;
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
  /** Whether an owner or admin allowed this computer's removal first: what the uninstall route answers (false until set). */
  setUninstallAuthorized(value: boolean): void;
  close(): Promise<void>;
}

export interface FakeCloudOptions { host?: string; port?: number; autoApprove?: boolean }

const LETTERS = "BCDFGHJKLMNPQRSTVWXZ";
const newUserCode = () => Array.from(randomBytes(8), (b, i) => (i === 4 ? "-" : "") + LETTERS[b % LETTERS.length]).join("");

interface Code { user_code: string; approved: boolean; consumed: boolean; polled: boolean; enrollment_token?: string }

/** The workspace's limits on one /v1/summaries request: the body (bytes) and how many summaries it carries. */
export const MAX_SUMMARIES_BODY_BYTES = 1024 * 1024;
export const MAX_SUMMARIES_PER_POST = 20;
/** How far in the future a summary's window may end (clock skew). */
const SUMMARY_MAX_FUTURE_SKEW_MS = 5 * 60_000;

/** The refusal codes the workspace's machine routes answer with, each with the one thing to do about it. */
const REMEDIATION = {
  credential_refused: "This computer's connection was revoked, replaced or removed. Sign it in again with the hook's login command; its records stay queued until then.",
  bad_request: "Send JSON of the form {\"receipts\": [...]}; update the hook if this repeats.",
  batch_too_large: "Send smaller batches; the hook splits batches itself, so update it if this repeats.",
  invalid_receipt: "A record failed validation. It stays in the local log; update the hook if this repeats.",
} as const;
const refusal = (code: keyof typeof REMEDIATION, error: string) => ({ error, code, remediation: REMEDIATION[code] });

class SummaryError extends Error {}
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (o: Obj, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const isText = (v: unknown, min: number, max: number): v is string => typeof v === "string" && v.length >= min && v.length <= max;
// eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored, fixed-width fields, and the optional fraction starts with a literal "."
const isTime = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
const HEX64 = /^[0-9a-f]{64}$/;
const KID = /^key:[0-9a-f]{16}$/;
const RESULTS = new Set(["allow", "not_evaluated"]);

/** The closed shape and cross-field rules the workspace checks on one summary record (`{ payload, signature }`); throws
 *  SummaryError with the workspace's wording for the first problem. The signature itself is not verified here. */
function checkSummary(record: unknown): Obj {
  if (!isObj(record) || !onlyKeys(record, ["payload", "signature"]) || !isObj(record.payload) || !isObj(record.signature)) throw new SummaryError("a summary is { payload, signature }");
  const s = record.signature;
  if (s.alg !== "Ed25519" || !isText(s.sig, 1, 200) || !onlyKeys(s, ["alg", "sig"])) throw new SummaryError("signature must be { alg: Ed25519, sig }");
  const p = record.payload;
  const keys = ["type", "version", "canonicalization", "evidence_class", "summary_id", "attester", "session_id", "harness", "window",
    "receipt_count", "receipts_root", "notable_count", "counts", "dedupe", "timestamp"];
  if (!onlyKeys(p, keys)) throw new SummaryError("the summary has an unknown member");
  if (p.type !== "scopebond:summary" || p.version !== "1.0" || p.canonicalization !== "RFC8785" || p.evidence_class !== "summary") throw new SummaryError("not a scopebond:summary 1.0 record");
  if (!isText(p.summary_id, 16, 200)) throw new SummaryError("summary_id must be 16 to 200 characters");
  if (!isObj(p.attester) || p.attester.kind !== "gateway" || typeof p.attester.kid !== "string" || !KID.test(p.attester.kid)) throw new SummaryError("attester must be { kind: gateway, kid }");
  if (p.session_id !== undefined && p.session_id !== null && !isText(p.session_id, 1, 200)) throw new SummaryError("session_id is malformed");
  if (p.harness !== undefined && p.harness !== null && (typeof p.harness !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(p.harness))) throw new SummaryError("harness is malformed");
  const w = p.window;
  if (!isObj(w) || (w.kind !== "interval" && w.kind !== "session") || !isTime(w.start) || !isTime(w.end) || Date.parse(w.start) > Date.parse(w.end)) throw new SummaryError("window must be { kind, start, end } running forwards");
  if (!isInt(p.receipt_count, 1, 1_000_000) || !isInt(p.notable_count, 0, 1_000_000)) throw new SummaryError("receipt_count and notable_count must be whole numbers");
  if (typeof p.receipts_root !== "string" || !HEX64.test(p.receipts_root)) throw new SummaryError("receipts_root must be 64 lowercase hex");
  if (!isTime(p.timestamp)) throw new SummaryError("timestamp must be an RFC 3339 time");
  if (!Array.isArray(p.counts) || p.counts.length > 500 || !Array.isArray(p.dedupe) || p.dedupe.length > 500) throw new SummaryError("counts and dedupe must be lists of at most 500");
  let counted = 0;
  for (const c of p.counts) {
    if (!isObj(c) || !onlyKeys(c, ["action_type", "result", "program", "cwd_digest", "count"]) || !isText(c.action_type, 1, 100) || !RESULTS.has(c.result as string)
      || (c.program !== null && !isText(c.program, 1, 100)) || (c.cwd_digest !== null && (typeof c.cwd_digest !== "string" || !HEX64.test(c.cwd_digest))) || !isInt(c.count, 1, 1_000_000)) {
      throw new SummaryError("a count line is malformed (a summary counts only allowed and unevaluated actions)");
    }
    counted += c.count;
  }
  if (counted !== p.receipt_count) throw new SummaryError("the counts must add up to receipt_count");
  const start = Date.parse(w.start), end = Date.parse(w.end);
  for (const d of p.dedupe) {
    if (!isObj(d) || !onlyKeys(d, ["key", "count", "first_at", "last_at"]) || typeof d.key !== "string" || !HEX64.test(d.key) || !isInt(d.count, 2, p.receipt_count)
      || !isTime(d.first_at) || !isTime(d.last_at) || Date.parse(d.first_at) > Date.parse(d.last_at) || Date.parse(d.first_at) < start || Date.parse(d.last_at) > end) {
      throw new SummaryError("a repeat line is malformed or outside the window");
    }
  }
  return p;
}

/** The record numbers beside a summary: closed ranges of the computer's queue numbers it stands for (null when malformed). */
function rangesFrom(value: unknown): Array<[number, number]> | null {
  const ranges = isObj(value) ? value.ranges : null;
  if (!Array.isArray(ranges) || ranges.length > 10_000) return null;
  const out: Array<[number, number]> = [];
  for (const r of ranges) {
    if (!Array.isArray(r) || r.length !== 2 || !isInt(r[0], 1, Number.MAX_SAFE_INTEGER) || !isInt(r[1], r[0], Number.MAX_SAFE_INTEGER)) return null;
    out.push([r[0], r[1]]);
  }
  return out;
}

export function startFakeCloud(options: FakeCloudOptions = {}): Promise<FakeCloud> {
  const { host = "127.0.0.1", port = 0, autoApprove = false } = options;
  const codes = new Map<string, Code>();
  const credentials = new Set<string>();
  /** Keys a repository run enrolled with. */
  const enrolledKids = new Set<string>();
  const faults = new Map<FakeRoute, Fault>();
  let clientVersion: { policy: "recommended" | "hold"; hook: string | null; agent: string | null } | null = null;
  let uninstallAuthorized = false;
  /** Summary ids held, so a summary sent again is answered as a duplicate. */
  const summaryIds = new Set<string>();
  const seen = {
    codeRequests: [] as FakeCloudState["code_requests"], installKeys: [] as string[], enrollMachineIds: [] as FakeCloudState["enroll_machine_ids"],
    checkinMachineIds: [] as FakeCloudState["checkin_machine_ids"], enrolled: 0, repositoryEnrollments: [] as FakeCloudState["repository_enrollments"], ingested: [] as unknown[], observations: 0,
    selfChecks: [] as FakeCloudState["self_checks"], policyPolls: 0, versionPolls: 0, approved: [] as string[],
    faultsApplied: [] as FakeCloudState["faults_applied"],
    summaries: 0, summarizedRecords: 0, summaryDuplicates: 0, summaryRejected: 0, lastSummaries: null as unknown, uninstalls: [] as FakeCloudState["uninstalls"],
  };

  const routeOf = (path: string): FakeRoute | null => {
    const name = path.replace(/^\/v1\//, "");
    return (["device/code", "device/token", "enroll", "repository/enroll", "ingest", "observations", "policy", "self-check", "client-version", "summaries", "uninstall"] as const).find((r) => r === name) ?? null;
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
      if (route === "policy" || route === "ingest" || route === "summaries" || route === "observations") {
        const header = req.headers["x-scopebond-machine-id"];
        seen.checkinMachineIds.push({ route, machine_id: typeof header === "string" ? header : null });
      }
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
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    const authed = () => credentials.has(bearer);
    // These two read their own bodies, as the workspace does: summaries refuse a body they cannot read with their own code,
    // and the uninstall notice is recorded whatever it carries.
    if (url.pathname === "/v1/summaries" && req.method === "POST") return summaries(raw, authed(), json);
    if (url.pathname === "/v1/uninstall" && req.method === "POST") return uninstall(raw, authed(), req, json);
    let body: Record<string, unknown> = {};
    try { body = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { return json(400, { error: "invalid_json" }); }
    const origin = `http://${req.headers.host}`;
    const path = url.pathname;

    if (path === "/healthz") return json(200, { ok: true });
    if (path === "/v1/device/code" && req.method === "POST") {
      seen.codeRequests.push({ client_name: typeof body.client_name === "string" ? body.client_name : null, harness: typeof body.harness === "string" ? body.harness : null, machine_id: typeof body.machine_id === "string" ? body.machine_id : null });
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
    // An install key: `sbk_fake…` connects, `sbk_fake_revoked…` was revoked, `sbk_fake_full…` reached its daily limit.
    if (path === "/v1/install/enroll" && req.method === "POST") {
      const key = typeof body.key === "string" ? body.key : "";
      seen.installKeys.push(key);
      if (!key.startsWith("sbk_fake") || key.startsWith("sbk_fake_revoked")) return json(401, { error: "the install key is not valid or was revoked", code: "invalid_credential" });
      if (key.startsWith("sbk_fake_full")) return json(429, { error: "this install key has connected as many new computers as it allows today", code: "quota" });
      return json(200, {
        enrollment: {
          enrollment_token: "sbe_fake_" + randomBytes(12).toString("hex"),
          proof_canonical: JSON.stringify({ challenge: randomBytes(8).toString("hex"), enrollment_id: "enr-key", type: "scopebond:gateway-enrollment", version: 1 }),
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        },
        organization_id: "org-fake", environment_id: "env-fake", agent_id: "agent-unclaimed", workspace: { name: "Fake workspace", region: "us" },
      });
    }
    if (path === "/v1/enroll" && req.method === "POST") {
      const known = [...codes.values()].some((c) => c.enrollment_token && c.enrollment_token === body.enrollment_token) || (typeof body.enrollment_token === "string" && body.enrollment_token.startsWith("sbe_fake"));
      if (!known || typeof body.public_key_pem !== "string") return json(400, { error: "invalid_enrollment" });
      seen.enrollMachineIds.push(typeof body.machine_id === "string" ? body.machine_id : null);
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
    // A repository token: `sbr_fake…` is known, `sbr_fake_revoked…` was revoked. Both keys prove possession over the
    // canonical proof (sorted keys) the hook signs; the answer is a short-lived machine credential.
    if (path === "/v1/repository/enroll" && req.method === "POST") {
      const token = typeof body.repository_token === "string" ? body.repository_token : "";
      if (!token.startsWith("sbr_fake") || token.startsWith("sbr_fake_revoked")) return json(401, { error: "unauthorized", code: "credential_refused" });
      const pem = typeof body.public_key_pem === "string" ? body.public_key_pem : "";
      const agentPem = typeof body.agent_public_key_pem === "string" ? body.agent_public_key_pem : "";
      if (!pem || !agentPem || typeof body.issued_at !== "string") return json(400, { error: "invalid_request" });
      const proof = JSON.stringify(Object.fromEntries(Object.entries({
        type: "scopebond:repository-enrollment", version: 1, token_sha256: createHash("sha256").update(token).digest("hex"),
        issued_at: body.issued_at, public_key_pem: pem, agent_public_key_pem: agentPem,
      }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
      const verified = (key: string, signature: unknown) => {
        try { return typeof signature === "string" && edVerify(null, Buffer.from(proof), createPublicKey(key), Buffer.from(signature, "base64")); } catch { return false; }
      };
      const proofsVerified = verified(pem, body.signature) && verified(agentPem, body.agent_signature);
      seen.repositoryEnrollments.push({ repository: typeof body.repository === "string" ? body.repository : null, proofs_verified: proofsVerified });
      if (!proofsVerified) return json(400, { error: "invalid possession proof" });
      // Like the workspace, a key is enrolled once: a run reusing one is told to make new keys.
      const runKids = [kidForPem(pem), kidForPem(agentPem)];
      if (runKids.some((kid) => enrolledKids.has(kid))) return json(409, { error: "these keys are already registered in this workspace; generate new keys and enroll again", code: "gateway_key_conflict" });
      for (const kid of runKids) enrolledKids.add(kid);
      const credential = "sbm_" + randomBytes(16).toString("hex");
      credentials.add(credential);
      const n = seen.repositoryEnrollments.length;
      return json(201, {
        credential_id: `repo-cred-${n}`, credential, organization_id: "org-fake", environment_id: "env-fake",
        gateway_id: "gw-repo", installation_id: "gw-repo", installation_generation: 1, agent_id: "agent-fake",
        attester_kid: kidForPem(pem), agent_kid: kidForPem(agentPem), scopes: ["receipt:ingest", "gateway:heartbeat"],
        expires_at: new Date(Date.now() + 86_400_000).toISOString(), repository: "github.com/fake/repo",
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
      seen.selfChecks.push({ failed, hook_version: typeof body.hook_version === "string" ? body.hook_version : null, agent_version: typeof body.agent_version === "string" ? body.agent_version : null,
        tools: Array.isArray(body.tools) ? body.tools : null, mcp_servers: Array.isArray(body.mcp_servers) ? body.mcp_servers : null });
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

  // Signed summaries standing for a window's routine records: `{ summaries: [{ summary: { payload, signature }, seq? }], queue? }`.
  // As the workspace: the request is refused whole only when it cannot be read (400 bad_request), is too big (413
  // batch_too_large) or every summary in it was refused (400 invalid_receipt, with `rejected`); otherwise each bad summary is
  // refused on its own in `rejected` and the rest are held (a summary id is held once; sent again it is a duplicate).
  function summaries(raw: string, authed: boolean, json: (status: number, value?: unknown) => void): void {
    if (!authed) return json(401, refusal("credential_refused", "unauthorized"));
    if (Buffer.byteLength(raw, "utf8") > MAX_SUMMARIES_BODY_BYTES) return json(413, refusal("batch_too_large", "ingest body exceeds 1 MiB"));
    let body: { summaries?: unknown } | null;
    try { body = JSON.parse(raw) as { summaries?: unknown } | null; } catch { return json(400, refusal("bad_request", "summaries[] required")); }
    const items = body?.summaries;
    if (!Array.isArray(items) || !items.length) return json(400, refusal("bad_request", "summaries[] required"));
    if (items.length > MAX_SUMMARIES_PER_POST) return json(413, refusal("batch_too_large", `at most ${MAX_SUMMARIES_PER_POST} summaries are accepted per request`));
    const rejected: Array<{ index: number; summary_id: string | null; reason: string }> = [];
    const fresh: Obj[] = [];
    const inRequest = new Set<string>();
    let duplicates = 0;
    for (const [index, item] of items.entries()) {
      const sent = isObj(item) ? item.summary : undefined;
      const id = isObj(sent) && isObj(sent.payload) && typeof sent.payload.summary_id === "string" ? sent.payload.summary_id.slice(0, 200) : null;
      try {
        const payload = checkSummary(sent);
        if (Date.parse((payload.window as Obj).end as string) > Date.now() + SUMMARY_MAX_FUTURE_SKEW_MS) throw new SummaryError("the window ends in the future");
        // The numbers beside a summary must account for exactly the records it covers, no more.
        const seq = isObj(item) ? item.seq : undefined;
        const numbers = seq === undefined ? [] : rangesFrom(seq);
        const unnumbered = isObj(seq) ? seq.unnumbered : 0;
        if (numbers === null || !isInt(unnumbered, 0, 1_000_000)) throw new SummaryError("the record numbers are malformed");
        if (seq !== undefined && numbers.reduce((n, [a, b]) => n + b - a + 1, 0) + unnumbered !== payload.receipt_count) {
          throw new SummaryError("the record numbers do not match the records the summary covers");
        }
        const summaryId = payload.summary_id as string;
        if (inRequest.has(summaryId) || summaryIds.has(summaryId)) { duplicates += 1; continue; }
        inRequest.add(summaryId);
        fresh.push(payload);
      } catch (error) {
        if (!(error instanceof SummaryError)) throw error;
        rejected.push({ index, summary_id: id, reason: error.message });
      }
    }
    for (const payload of fresh) summaryIds.add(payload.summary_id as string);
    const actions = fresh.reduce((n, p) => n + (p.receipt_count as number), 0);
    seen.summaries += fresh.length;
    seen.summarizedRecords += actions;
    seen.summaryDuplicates += duplicates;
    seen.summaryRejected += rejected.length;
    seen.lastSummaries = body;
    // Refused as they are, these summaries can never pass: the computer then sends those records in full.
    if (!fresh.length && !duplicates && rejected.length) return json(400, { ...refusal("invalid_receipt", rejected[0].reason), rejected });
    return json(200, { ok: true, accepted: fresh.length, duplicates, actions, rejected });
  }

  // A computer removing Scopebond says so first (the hook sends `{ purge, hook_version }`). As the workspace, the body does not
  // shape the answer: the notice is recorded whatever it carries, and the answer says only whether the removal was allowed.
  function uninstall(raw: string, authed: boolean, req: http.IncomingMessage, json: (status: number, value?: unknown) => void): void {
    if (!authed) return json(401, refusal("credential_refused", "unauthorized"));
    let body: unknown = raw;
    try { body = raw ? JSON.parse(raw) as unknown : null; } catch { /* kept as the raw text */ }
    const fields = isObj(body) ? body : {};
    const header = req.headers["x-scopebond-hook-version"];
    seen.uninstalls.push({
      purge: typeof fields.purge === "boolean" ? fields.purge : null,
      hook_version: typeof fields.hook_version === "string" ? fields.hook_version : null,
      header_hook_version: typeof header === "string" ? header : null,
      body,
    });
    return json(200, { authorized: uninstallAuthorized });
  }

  function approve(userCode?: string): boolean {
    const entry = [...codes.values()].reverse().find((c) => !c.approved && !c.consumed && (!userCode || c.user_code === userCode));
    if (!entry) return false;
    entry.approved = true;
    seen.approved.push(entry.user_code);
    return true;
  }

  const state = (): FakeCloudState => ({
    code_requests: seen.codeRequests, install_keys: seen.installKeys, enroll_machine_ids: seen.enrollMachineIds, checkin_machine_ids: seen.checkinMachineIds, enrolled: seen.enrolled, repository_enrollments: seen.repositoryEnrollments, ingested: seen.ingested.length,
    ingested_results: seen.ingested.map((r) => ((r as { payload?: { realtime_result?: string } })?.payload?.realtime_result ?? null)),
    observations: seen.observations, self_checks: seen.selfChecks, policy_polls: seen.policyPolls, version_polls: seen.versionPolls,
    approved_codes: seen.approved, pending_codes: [...codes.values()].filter((c) => !c.approved && !c.consumed).map((c) => c.user_code),
    faults_applied: seen.faultsApplied,
    summaries: seen.summaries, summarized_records: seen.summarizedRecords, summary_duplicates: seen.summaryDuplicates, summary_rejected: seen.summaryRejected,
    last_summaries: seen.lastSummaries, uninstalls: seen.uninstalls,
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
        setUninstallAuthorized: (value) => { uninstallAuthorized = value; },
        close: () => new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
      });
    });
  });
}
