// Live demo of the Scopebond Gateway on Cloudflare Workers.
//
// Same gateway core as `npx scopebond-gateway`, running at the edge: policy
// enforcement (prevent), Ed25519-countersigned receipts with a persistent,
// KV-stored attester key (prove), and a kill switch. Receipts live in KV.
import { createWorkerGateway } from "@scopebond/gateway";
import policy from "./policy.json";

interface Env { RECEIPTS: KVNamespace }

let gatewayPromise: ReturnType<typeof createWorkerGateway> | undefined;

const LANDING = `<!doctype html><meta charset=utf-8><title>Scopebond Gateway — live demo</title>
<style>body{font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:6vh auto;padding:0 20px;background:#070b18;color:#eaf0fb}
code,pre{font-family:ui-monospace,Menlo,Consolas,monospace}pre{background:#0d1329;border:1px solid #1d2949;border-radius:10px;padding:14px;overflow:auto}
a{color:#8fb3ff}h1{letter-spacing:-.02em}.muted{color:#9fb0cf}</style>
<h1>Scopebond Gateway — live demo</h1>
<p class=muted>A policy-enforcement gateway for AI agents: <b>prevent</b> out-of-policy actions,
<b>prove</b> every attempt with an Ed25519-countersigned receipt. This is the open-source
<code>@scopebond/gateway</code> running on Cloudflare Workers.</p>
<p>Try an in-policy action (allowed) and an over-limit one (denied, fail closed):</p>
<pre>curl -sX POST https://try.scopebond.com/v1/evaluate \\
  -H 'content-type: application/json' \\
  -d '{"intent":{"action_type":"payout.create","asset":"USDC","amount":500000}}'

curl -sX POST https://try.scopebond.com/v1/evaluate \\
  -H 'content-type: application/json' \\
  -d '{"intent":{"action_type":"payout.create","asset":"USDC","amount":2000000}}'</pre>
<p>Then inspect: <a href=/v1/status>/v1/status</a> ·
<a href=/v1/receipts>/v1/receipts</a> ·
<a href=/v1/attester>/v1/attester</a> ·
<a href=/.well-known/jwks.json>/.well-known/jwks.json</a></p>
<p class=muted>Every receipt is independently verifiable against the attester's published
key — no trust in this server required. Docs: <a href=https://scopebond.com>scopebond.com</a>.</p>`;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(LANDING, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    gatewayPromise ??= createWorkerGateway({ policy, kv: env.RECEIPTS });
    const gateway = await gatewayPromise;
    return gateway.app.fetch(request, env, ctx);
  },
};
