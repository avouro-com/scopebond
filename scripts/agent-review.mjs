#!/usr/bin/env node
/**
 * agent-review.mjs — automated scope review (PRs) and triage (issues) against
 * SCOPE.md, using an LLM. Self-contained: Node built-ins only (global fetch).
 * Called from GitHub Actions:
 *
 *   node scripts/agent-review.mjs pr      # pull_request event
 *   node scripts/agent-review.mjs issue   # issues event
 *
 * Provider is auto-detected from whichever secret is set:
 *   - ANTHROPIC_API_KEY  → Claude (Anthropic Messages API)
 *   - DEEPSEEK_TOKEN     → DeepSeek (OpenAI-compatible chat completions)
 * If neither is set, this is a clean no-op. Override the model with
 * SCOPE_REVIEW_MODEL.
 *
 * Env also: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH (from Actions).
 *
 * Behavior: posts ONE comment with a verdict and applies labels. Out-of-scope
 * items get `needs-maintainer` and are routed to a human — never auto-closed.
 * Exits 0 (advisory) so it informs rather than hard-blocks.
 */

import { readFileSync, existsSync } from "node:fs";

const MODE = process.argv[2];
if (MODE !== "pr" && MODE !== "issue") { console.error('usage: agent-review.mjs pr|issue'); process.exit(2); }

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DEEPSEEK_KEY = process.env.DEEPSEEK_TOKEN;
const PROVIDER = ANTHROPIC_KEY ? "anthropic" : DEEPSEEK_KEY ? "deepseek" : null;
const MODEL = process.env.SCOPE_REVIEW_MODEL || (PROVIDER === "anthropic" ? "claude-sonnet-5" : "deepseek-chat");

const GH_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const EVENT = process.env.GITHUB_EVENT_PATH;

if (!PROVIDER) { console.log("agent-review: no LLM key (ANTHROPIC_API_KEY or DEEPSEEK_TOKEN) — skipping (no-op)."); process.exit(0); }
if (!EVENT || !existsSync(EVENT) || !GH_TOKEN || !REPO) { console.log("agent-review: missing GitHub context — skipping."); process.exit(0); }

const event = JSON.parse(readFileSync(EVENT, "utf8"));
const [owner, repo] = REPO.split("/");
const scope = existsSync("SCOPE.md") ? readFileSync("SCOPE.md", "utf8") : "(SCOPE.md not found)";

const GH = "https://api.github.com";
const ghHeaders = { authorization: `Bearer ${GH_TOKEN}`, "user-agent": "scopebond-agent-review", accept: "application/vnd.github+json" };

async function gh(path, opts = {}) {
  const r = await fetch(`${GH}${path}`, { ...opts, headers: { ...ghHeaders, ...(opts.headers || {}) } });
  if (!r.ok && opts.method) console.error(`GitHub ${opts.method} ${path} → ${r.status}`);
  return r;
}

async function callLLM(system, user) {
  if (PROVIDER === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, messages: [{ role: "user", content: user }] }),
    });
    if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${await r.text()}`);
    const data = await r.json();
    return (data.content || []).map((b) => b.text || "").join("");
  }
  // DeepSeek (OpenAI-compatible)
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${DEEPSEEK_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: false, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`DeepSeek API ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content ?? "";
}

function parseVerdict(text) {
  const m = text.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : text); } catch { return null; }
}

const LABELS = {
  ALIGNED: ["scope:aligned"],
  "NEEDS-CHANGES": ["scope:needs-changes"],
  "OUT-OF-SCOPE": ["scope:out-of-scope", "needs-maintainer"],
};

async function run() {
  let number, subject;
  if (MODE === "pr") {
    number = event.pull_request?.number;
    const diffRes = await gh(`/repos/${owner}/${repo}/pulls/${number}`, { headers: { accept: "application/vnd.github.v3.diff" } });
    const diff = (await diffRes.text()).slice(0, 60000);
    subject = `Title: ${event.pull_request?.title}\n\nDescription:\n${event.pull_request?.body || "(none)"}\n\nDiff (truncated to 60k):\n${diff}`;
  } else {
    number = event.issue?.number;
    subject = `Title: ${event.issue?.title}\n\nBody:\n${event.issue?.body || "(none)"}`;
  }
  if (!number) { console.log("agent-review: no PR/issue number — skipping."); return; }

  const system = `You are the Scopebond scope-review agent. Judge the item strictly against the scope policy below. Reply with ONLY a JSON object: {"verdict":"ALIGNED|NEEDS-CHANGES|OUT-OF-SCOPE","summary":"one sentence","reasons":["cite the specific SCOPE.md rule(s)"]}. When uncertain, prefer NEEDS-CHANGES or OUT-OF-SCOPE over ALIGNED.\n\n===== SCOPE.md =====\n${scope}`;
  const text = await callLLM(system, subject);
  const v = parseVerdict(text);
  if (!v || !LABELS[v.verdict]) { console.error("agent-review: could not parse a verdict; leaving untouched.\n", text); return; }

  const body = `**Scope review${MODE === "issue" ? " (triage)" : ""}: ${v.verdict}**\n\n${v.summary || ""}\n\n${(v.reasons || []).map((r) => `- ${r}`).join("\n")}\n\n${v.verdict === "OUT-OF-SCOPE" ? "Routed to a maintainer for a decision — not closed automatically." : ""}\n\n_Automated first pass against [SCOPE.md](SCOPE.md); a maintainer makes the final call._`;
  await gh(`/repos/${owner}/${repo}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  await gh(`/repos/${owner}/${repo}/issues/${number}/labels`, { method: "POST", body: JSON.stringify({ labels: LABELS[v.verdict] }) });
  console.log(`agent-review: ${MODE} #${number} → ${v.verdict} (${PROVIDER}/${MODEL})`);
}

run().catch((e) => { console.error("agent-review error:", e.message); process.exit(0); }); // advisory: never fail the build
