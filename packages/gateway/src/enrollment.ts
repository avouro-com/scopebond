import type { Attester } from "./receipts.js";
import { canonical } from "./crypto.js";

export interface CloudEnrollmentBundle {
  enrollment_token: string;
  proof_canonical: string;
  expires_at?: string;
}

export interface CloudEnrollmentResult {
  credential_id: string;
  credential: string;
  organization_id: string;
  environment_id: string;
  gateway_id: string;
  attester_kid: string;
  /** Present only when the enrolling client supplied and proved its agent key. */
  agent_kid?: string;
  scopes: string[];
  expires_at: string;
}

export async function completeCloudEnrollment(options: {
  url: string;
  bundle: CloudEnrollmentBundle;
  attester: Attester;
  /** Optional separate signing key used by authenticated hook receipts. */
  agent?: Attester;
  fetch?: typeof fetch;
}): Promise<CloudEnrollmentResult> {
  const endpoint = new URL("/v1/enroll", options.url);
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") {
    throw new TypeError("Cloud enrollment requires HTTPS (except localhost development)");
  }
  if (endpoint.username || endpoint.password) throw new TypeError("Cloud enrollment URL must not contain credentials");
  if (!/^sbe_[A-Za-z0-9_-]+$/.test(options.bundle.enrollment_token)) {
    throw new TypeError("invalid enrollment token");
  }
  let proof: unknown;
  try { proof = JSON.parse(options.bundle.proof_canonical); }
  catch { throw new TypeError("invalid enrollment proof"); }
  if (canonical(proof) !== options.bundle.proof_canonical) throw new TypeError("enrollment proof is not canonical");
  const claims = proof as Record<string, unknown>;
  if (claims.type !== "scopebond:gateway-enrollment" || claims.version !== 1
    || typeof claims.enrollment_id !== "string" || typeof claims.challenge !== "string") {
    throw new TypeError("unsupported enrollment proof");
  }
  if (options.bundle.expires_at && Date.parse(options.bundle.expires_at) <= Date.now()) {
    throw new Error("Cloud enrollment bundle has expired");
  }

  const agentPublicKeyPem = options.agent?.publicKeyPem.trim();
  const proofCanonical = options.agent
    ? canonical({ ...claims, agent_public_key_pem: agentPublicKeyPem })
    : options.bundle.proof_canonical;
  const response = await (options.fetch ?? fetch)(endpoint, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enrollment_token: options.bundle.enrollment_token,
      public_key_pem: options.attester.publicKeyPem,
      signature: await options.attester.sign(proofCanonical),
      ...(options.agent ? {
        agent_public_key_pem: agentPublicKeyPem,
        agent_signature: await options.agent.sign(proofCanonical),
      } : {}),
    }),
  });
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > 65_536) throw new Error("Cloud enrollment response exceeded 64 KiB");
  const text = await response.text();
  if (text.length > 65_536) throw new Error("Cloud enrollment response exceeded 64 KiB");
  let result: Partial<CloudEnrollmentResult> & { error?: string };
  try { result = JSON.parse(text) as Partial<CloudEnrollmentResult> & { error?: string }; }
  catch { throw new Error(`Cloud enrollment returned an invalid response (${response.status})`); }
  if (!response.ok) throw new Error(result.error ?? `Cloud enrollment failed (${response.status})`);
  if (!result.credential?.startsWith("sbm_") || result.attester_kid !== options.attester.kid) {
    throw new Error("Cloud enrollment returned an invalid credential binding");
  }
  if (options.agent && result.agent_kid !== options.agent.kid) {
    throw new Error("Cloud enrollment did not register the agent signing key; update the server and obtain a fresh enrollment");
  }
  return result as CloudEnrollmentResult;
}
