import http from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { observationSigningInput } from "@scopebond/policy-schema";
import { scaffold } from "../dist/index.js";

/** A throwaway hook home with keys, a starter policy and a Cloud connection that carries
 *  (or lacks) what observations need. Nothing under the real home or agent settings. */
export function makeHome(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sb-obs-"));
  scaffold(dir, {});
  const { attester: agent } = loadOrCreateAttester({ file: join(dir, "agent.key") });
  const connection = {
    url: options.url ?? "http://127.0.0.1:9",
    credential_id: "cred-1", credential: "sbm_test-credential", organization_id: "org-1", environment_id: "env-1",
    gateway_id: "gw-1", attester_kid: "kid-attester", agent_kid: agent.kid,
    scopes: options.scopes ?? ["receipts:write", "observations:write"], expires_at: "2099-01-01T00:00:00Z",
    ...(options.installation_id === null ? {} : { installation_id: options.installation_id ?? "inst-test-1" }),
    ...(options.generation === null ? {} : { installation_generation: options.generation ?? 1 }),
  };
  writeFileSync(join(dir, "cloud.json"), JSON.stringify(connection, null, 2));
  return { dir, agent, connection };
}

export const verifyWrapper = (wrapper, publicKeyPem) =>
  verify(null, Buffer.from(observationSigningInput(wrapper.payload), "utf8"), createPublicKey(publicKeyPem), Buffer.from(wrapper.signature.value, "base64url"));

/** Local stand-in for the workspace's observation route. `handler(items, request)` returns
 *  `{ status, body, headers }`; the default acknowledges everything. */
export async function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const record = { method: req.method, url: req.url, headers: req.headers, raw: body, json: undefined };
      try { record.json = JSON.parse(body); } catch { /* not JSON */ }
      requests.push(record);
      if (req.url === "/v1/ingest") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ accepted: 0 })); return; }
      const answer = (handler ?? acceptAll)(record.json?.items ?? [], record, requests.length);
      if (answer === "drop") { req.socket.destroy(); return; }
      res.writeHead(answer.status ?? 200, { "content-type": "application/json", ...(answer.headers ?? {}) });
      res.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
    observations: () => requests.filter((r) => r.url === "/v1/observations").flatMap((r) => r.json?.items ?? []) };
}

export const results = (items, status = "accepted", code = "ok") =>
  ({ version: "1.0", results: items.map((item, index) => ({ index, observation_id: item.payload.observation_id, status, code, retryable: status === "deferred" })) });
export const acceptAll = (items) => ({ status: 200, body: results(items) });

export const readPending = (dir) => {
  // Read straight from the outbox file, as the tool under test wrote it.
  return import("node:module").then(({ createRequire }) => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const db = new DatabaseSync(join(dir, "observations.db"));
    try { return db.prepare("SELECT wrapper FROM pending ORDER BY generation, sequence").all().map((r) => JSON.parse(r.wrapper)); }
    finally { db.close(); }
  });
};
export const publicKeyOf = (dir) => {
  const { attester } = loadOrCreateAttester({ file: join(dir, "agent.key") });
  return attester.publicKeyPem;
};
export const readText = (file) => readFileSync(file, "utf8");
