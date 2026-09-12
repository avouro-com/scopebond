#!/usr/bin/env node
// scopebond-gateway <policy.json> — run the gateway as a standalone Node server.
import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { createGateway } from "./index.js";

const policyPath = process.argv[2] ?? process.env.SCOPEBOND_POLICY;
if (!policyPath) {
  console.error("usage: scopebond-gateway <policy.json>   (or set SCOPEBOND_POLICY)");
  process.exit(1);
}

const policy = JSON.parse(readFileSync(policyPath, "utf8"));
const { app, attester, policyHash } = createGateway({ policy });
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port });
console.log(`scopebond-gateway listening on :${port}`);
console.log(`  policy    ${policyPath} (hash ${policyHash.slice(0, 12)}…)`);
console.log(`  attester  ${attester.kid}`);
console.log(`  routes    POST /v1/evaluate · POST /mcp · POST /v1/kill · POST /v1/resume · GET /v1/receipts · GET /v1/status`);
