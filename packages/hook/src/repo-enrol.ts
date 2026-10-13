// Repository enrolment: a hook running where no person signed in (a cloud coding agent's sandbox, a CI job) delivers as
// one repository of a workspace. The workspace issues the repository a token; the repository keeps it as a secret that
// reaches the hook as `SCOPEBOND_REPO_TOKEN`. On its first tool call the hook sets itself up (keys and the starter rules),
// proves it holds the keys it just made, and exchanges the token for a short-lived delivery credential for that one
// repository. The token itself is never written to disk, printed or sent anywhere but the enrolment request.
//
// A hook that already has a connection (a person signed in on this computer) keeps it: the token is only used where no
// user credential exists.

import { createHash } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "@scopebond/gateway";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { connectionPath, loadConnection, type HookConnection } from "./cloud.js";
import { forgetCached } from "./config-cache.js";
import { scaffold } from "./init.js";
import { forgetWorkspaceAnnouncements } from "./receipt-context.js";
import { replaceFile } from "./safe-fs.js";
import { versionedFetch } from "./workspace-fetch.js";

/** The environment variable that carries a repository's token. */
export const REPO_TOKEN_ENV = "SCOPEBOND_REPO_TOKEN";
/** The environment variable that names the workspace a repository token belongs to (default: Scopebond Cloud). */
export const WORKSPACE_URL_ENV = "SCOPEBOND_URL";
export const DEFAULT_WORKSPACE_URL = "https://cloud.scopebond.com";

/** A repository token as the workspace issues it: `sbr_`, the database it lives in, then random characters. */
const TOKEN_SHAPE = /^sbr_[A-Za-z0-9_-]{16,200}$/;

/** Why repository enrolment failed. The message never contains the token. */
export class RepositoryEnrollmentError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly repair: string;
  constructor(message: string, options: { status?: number | null; code?: string | null; repair?: string } = {}) {
    super(message);
    this.name = "RepositoryEnrollmentError";
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.repair = options.repair ?? `check the ${REPO_TOKEN_ENV} secret this repository's agent runs with; create a new token in your workspace if it was revoked`;
  }
}

/** The repository token in the environment: null when none is set; an error when what is set is not one. */
export function repositoryToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[REPO_TOKEN_ENV]?.trim();
  if (!raw) return null;
  if (!TOKEN_SHAPE.test(raw)) throw new RepositoryEnrollmentError(`${REPO_TOKEN_ENV} is set but is not a Scopebond repository token`);
  return raw;
}

/** The workspace a repository token is exchanged with: `SCOPEBOND_URL` when it is an HTTPS origin (or localhost in
 *  development), otherwise Scopebond Cloud. A value with credentials in it is refused rather than used. */
export function repositoryWorkspaceUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[WORKSPACE_URL_ENV]?.trim();
  if (!raw) return DEFAULT_WORKSPACE_URL;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new RepositoryEnrollmentError(`${WORKSPACE_URL_ENV} is not a URL`); }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if ((parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) || parsed.username || parsed.password) {
    throw new RepositoryEnrollmentError(`${WORKSPACE_URL_ENV} must be an https:// workspace address without credentials`);
  }
  return parsed.origin;
}

/** What the enrolment request proves: both keys were made by this caller, for this token, now. Signed by both keys. */
export function repositoryEnrollmentProof(input: { token: string; issuedAt: string; publicKeyPem: string; agentPublicKeyPem: string }): string {
  return canonical({
    type: "scopebond:repository-enrollment", version: 1,
    token_sha256: createHash("sha256").update(input.token).digest("hex"),
    issued_at: input.issuedAt,
    public_key_pem: input.publicKeyPem.trim(),
    agent_public_key_pem: input.agentPublicKeyPem.trim(),
  });
}

/** A connection the hook made with a repository token (as opposed to a person's sign-in). */
export function isRepositoryConnection(connection: unknown): boolean {
  return (connection as { source?: unknown } | null | undefined)?.source === "repository";
}

/** A repository connection whose credential has run out (or says nothing about when it does): it is made again. */
function expired(connection: HookConnection, now: number): boolean {
  const at = Date.parse(connection.expires_at ?? "");
  return !Number.isFinite(at) || at - now < 60_000;
}

/** Which token a repository connection was made with, without keeping the token: SHA-256 of the token's SHA-256. */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(createHash("sha256").update(token).digest("hex")).digest("hex");
}

/** A repository connection this token may keep using: made with this same token, and not expired. */
function usable(connection: HookConnection | null, fingerprint: string, now: number): connection is HookConnection {
  return !!connection && isRepositoryConnection(connection) && (connection as { token_fingerprint?: unknown }).token_fingerprint === fingerprint
    && !expired(connection, now);
}

/** Move a repository connection's whole folder aside (keys, connection, rules), so the next enrolment starts with fresh keys:
 *  the workspace never takes a key twice. Records in the old folder stay there. */
function setAside(dir: string, now: number): void {
  try { renameSync(dir, `${dir}.retired-${now}`); }
  catch (error) {
    throw new RepositoryEnrollmentError(`could not set aside the previous repository connection in ${dir} (${error instanceof Error ? error.message : String(error)})`,
      { repair: `remove ${dir} in this environment, then try the action again` });
  }
}

const RESPONSE_LIMIT = 65_536;

/** Exchange the repository token for a delivery credential and keep it as this folder's connection (cloud.json). The
 *  folder is set up first when it has no rules yet. Throws a RepositoryEnrollmentError (no token in its message). */
export async function enrollRepository(
  dir: string,
  options: { token: string; url: string; repository?: string | null; fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number },
): Promise<HookConnection> {
  if (!existsSync(join(dir, "policy.json"))) scaffold(dir);
  const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  const { attester: agent } = loadOrCreateAttester({ file: join(dir, "agent.key") });
  const issuedAt = new Date((options.now ?? Date.now)()).toISOString();
  const proof = repositoryEnrollmentProof({ token: options.token, issuedAt, publicKeyPem: attester.publicKeyPem, agentPublicKeyPem: agent.publicKeyPem });
  const endpoint = new URL("/v1/repository/enroll", options.url);
  let response: Response;
  try {
    response = await versionedFetch(options.fetchImpl)(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repository_token: options.token,
        issued_at: issuedAt,
        public_key_pem: attester.publicKeyPem.trim(),
        signature: await attester.sign(proof),
        agent_public_key_pem: agent.publicKeyPem.trim(),
        agent_signature: await agent.sign(proof),
        ...(options.repository ? { repository: options.repository } : {}),
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
  } catch (error) {
    throw new RepositoryEnrollmentError(`could not reach the workspace at ${endpoint.origin} (${error instanceof Error ? error.name : "network error"})`,
      { repair: `check that the agent's sandbox may reach ${endpoint.origin}, and ${WORKSPACE_URL_ENV} if your workspace has its own address` });
  }
  const text = await response.text().catch(() => "");
  const body = parseAnswer(text);
  if (!response.ok) {
    const code = typeof body.code === "string" ? body.code.slice(0, 64) : null;
    // The workspace's own words, bounded and on one line; it never repeats the token.
    const said = typeof body.error === "string" ? body.error.replace(/\s+/g, " ").slice(0, 200) : `HTTP ${response.status}`;
    throw new RepositoryEnrollmentError(`the workspace refused this repository's token (${said})`, { status: response.status, code,
      ...(response.status === 429 || response.status === 503 ? { repair: "the workspace asked to wait; try the action again in a minute" } : {}) });
  }
  if (typeof body.credential !== "string" || !body.credential.startsWith("sbm_") || body.attester_kid !== attester.kid
    || (body.agent_kid !== undefined && body.agent_kid !== agent.kid)) {
    throw new RepositoryEnrollmentError("the workspace answered with a credential for different keys", { status: response.status });
  }
  const { ingest_url: offered, ...enrolled } = body;
  const ingest = safeOrigin(offered);
  const connection = { url: options.url, ...enrolled, ...(ingest ? { ingest_url: ingest } : {}), source: "repository", token_fingerprint: tokenFingerprint(options.token) } as unknown as HookConnection;
  forgetCached(connectionPath(dir));
  replaceFile(connectionPath(dir), JSON.stringify(connection, null, 2) + "\n");
  forgetWorkspaceAnnouncements(dir);
  return connection;
}

/** The workspace's answer as an object; anything else (too long, not JSON, not an object) reads as empty. */
function parseAnswer(text: string): Record<string, unknown> {
  if (text.length > RESPONSE_LIMIT) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function safeOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if ((parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) || parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch { return null; }
}

/** Where a tool call's records go when a repository token is set. A person's own connection always wins, and is looked for
 *  before the token is even read. Otherwise: the folder the hook already uses when it holds a repository connection or is
 *  set up (or is named by SCOPEBOND_HOOK_DIR), else the user home (a sandbox: the repository checkout stays clean).
 *  A repository connection is kept only while it is unexpired and was made with this same token; otherwise its folder is
 *  set aside and the repository enrols again with fresh keys. Returns `dir` unchanged when no token is set. */
export async function repositoryConnectionDir(
  dir: string,
  options: { home: string; repository?: () => string | null; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number },
): Promise<string> {
  const env = options.env ?? process.env;
  const existing = loadConnection(dir);
  if (existing && !isRepositoryConnection(existing)) return dir;
  if (!env[REPO_TOKEN_ENV]?.trim()) return dir;
  const token = repositoryToken(env) ?? "";
  const fingerprint = tokenFingerprint(token);
  const now = (options.now ?? Date.now)();
  const target = existing || existsSync(join(dir, "policy.json")) || env.SCOPEBOND_HOOK_DIR ? dir : options.home;
  const there = target === dir ? existing : loadConnection(target);
  if (there && !isRepositoryConnection(there)) return target;
  if (usable(there, fingerprint, now)) return target;
  // Expired, or made with another repository's token: fresh keys in a fresh folder.
  if (there) setAside(target, now);
  try {
    await enrollRepository(target, { token, url: repositoryWorkspaceUrl(env), repository: options.repository?.() ?? null, fetchImpl: options.fetchImpl, now: options.now });
  } catch (error) {
    // Two tool calls at once: the other one enrolled these same keys first. Only its connection, for this token, unexpired
    // and naming the key on disk, is taken; anything else is the refusal it is.
    if (error instanceof RepositoryEnrollmentError && error.code === "gateway_key_conflict") {
      const landed = loadConnection(target);
      const keyFile = join(target, "attester.key");
      if (usable(landed, fingerprint, now) && existsSync(keyFile) && landed.attester_kid === loadOrCreateAttester({ file: keyFile }).attester.kid) return target;
    }
    throw error;
  }
  return target;
}
