// A corpus of realistic, made-up secret shapes run through the real capture path (mapper -> runtime -> signed receipt ->
// cloud exporter): no credential may leave the computer, in full or in standard detail, nor sit in the local store. Every
// secret is built at run time from a seeded generator (no literal token in this file).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate every home-like location before the hook is loaded.
const SANDBOX = mkdtempSync(join(tmpdir(), "sb-redaction-"));
for (const k of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SCOPEBOND_HOME", "XDG_CONFIG_HOME"]) process.env[k] = join(SANDBOX, "home");
mkdirSync(join(SANDBOX, "home"), { recursive: true });

const hook = await import("../dist/index.js");
const gw = await import("@scopebond/gateway");
const { scaffold, createHookRuntime, mapClaudeToolUse, mapCodexToolUse, mapCursorEvent, actionSummary } = hook;
const { isNotable, buildSummary, createAttester } = gw;


// ---- fake secret generator: seeded, non-hex letters mixed in, unique per call --------------------------------------
let seed = 0x5eed;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
const ALNUM = "ghijkmnpqrstuvwxyzGHJKLMNPQRSTUVWXYZ0123456789abcdefABCDEF";
const UPPER = "GHJKLMNPQRSTUVWXYZ0123456789";
const r = (n, alphabet = ALNUM) => Array.from({ length: n }, () => alphabet[rnd() % alphabet.length]).join("");
const b64 = (n) => r(n, ALNUM + "+/");
const J = (...p) => p.join(""); // assemble prefixes so no full token literal appears in source

const CWD = "/srv/jane.example/work/acme-clinic"; // a folder named after a person (personal data in every shell record)
const bash = (command) => ({ tool_name: "Bash", tool_input: { command }, cwd: CWD });

// Each entry: id, shape, kind (credential | pii), harness, input, secret (the value that must not leave).
const corpus = [];
const add = (id, shape, kind, harness, input, secret, note = "") => corpus.push({ id, shape, kind, harness, input, secret, note });

{ const s = r(32); add("S01", "Authorization: Bearer header (curl)", "credential", "claude", bash(`curl -H "Authorization: Bearer ${s}" https://api.example.test/v1/me`), s); }
{ const s = r(32); add("S02", "X-Api-Key header (curl)", "credential", "claude", bash(`curl -H "X-Api-Key: ${s}" https://api.example.test/x`), s); }
{ const s = "Hu" + r(10); add("S03", "curl -u user:password", "credential", "claude", bash(`curl -u admin:${s} https://api.example.test/x`), s); }
{ const s = r(30); add("S04", "access_token in URL query (curl)", "credential", "claude", bash(`curl "https://api.example.test/v1/items?access_token=${s}"`), s); }
{ const s = r(22) + "%2B" + r(8) + "%3D"; add("S05", "Azure SAS sig= in URL query (curl)", "credential", "claude", bash(`curl "https://acct.blob.example.test/c/f?sv=2022&sig=${s}"`), s); }
{ const s = r(26); add("S06", "Cookie: sid= header", "credential", "claude", bash(`curl -H "Cookie: sid=${s}" https://app.example.test/`), s); }
{ const s = b64(40); add("S07", "export AWS_SECRET_ACCESS_KEY=", "credential", "claude", bash(`export AWS_SECRET_ACCESS_KEY=${s}`), s); }
{ const s = J("AK", "IA", r(16, UPPER)); add("S08", "AWS access key id (aws configure set)", "credential", "claude", bash(`aws configure set aws_access_key_id ${s}`), s); }
{ const s = b64(40); add("S09", "AWS secret as bare argv (aws configure set)", "credential", "claude", bash(`aws configure set aws_secret_access_key ${s}`), s); }
{ const s = J("gh", "p_", r(36)); add("S10", "GitHub PAT in env assignment", "credential", "claude", bash(`export GITHUB_TOKEN=${s}`), s); }
{ const s = J("gh", "p_", r(36)); add("S11", "GitHub PAT in clone URL userinfo", "credential", "claude", bash(`git clone https://${s}@github.com/org/repo.git`), s); }
{ const s = r(20); add("S12", "x-access-token:<tok>@ clone URL", "credential", "claude", bash(`git clone https://x-access-token:${s}@github.com/o/r.git`), s); }
{ const s = r(18); add("S13", "token-only userinfo (no colon, unrecognised shape) in git remote", "credential", "claude", bash(`git remote add origin https://${s}@git.example.test/o/r.git`), s); }
{ const s = r(18); add("S14", "token-only userinfo in git push remote (git.push params)", "credential", "claude", bash(`git push https://${s}@git.example.test/o/r.git feature-x`), s); }
{ const s = "Pw" + r(12); add("S15", "postgres:// user:password@ connection string", "credential", "claude", bash(`psql "postgres://app:${s}@db.example.test:5432/prod"`), s); }
{ const s = "Pw" + r(12); add("S16", "redis://:password@ (empty username)", "credential", "claude", bash(`redis-cli -u redis://:${s}@cache.example.test:6379 ping`), s); }
{ const s = "Pw" + r(10); add("S17", "mysql -p<password> (attached)", "credential", "claude", bash(`mysql -u root -p${s} prod`), s); }
{ const s = "Pw" + r(10); add("S18", "sshpass -p <password> (space separated)", "credential", "claude", bash(`sshpass -p ${s} ssh deploy@host.example.test`), s); }
{ const s = "Pw" + r(10); add("S19", "docker login -p <password>", "credential", "claude", bash(`docker login -u bob -p ${s} registry.example.test`), s); }
{ const s = "Pw" + r(12); add("S20", "az vm create --admin-password <pw>", "credential", "claude", bash(`az vm create -n vm1 -g rg1 --admin-password ${s}`), s); }
{ const s = r(34); add("S21", "--client-secret <value>", "credential", "claude", bash(`az login --service-principal --client-secret ${s}`), s); }
{ const s = "Pw" + r(12); add("S22", "export DB_PASS= (name without 'passw')", "credential", "claude", bash(`export DB_PASS=${s}`), s); }
{ const s = "Pw" + r(12); add("S23", "PGPASSWORD= env prefix", "credential", "claude", bash(`PGPASSWORD=${s} psql -h db.example.test`), s); }
{ const s = J("np", "m_", r(36)); add("S24", "npm token (npm config set _authToken)", "credential", "claude", bash(`npm config set //registry.npmjs.org/:_authToken ${s}`), s); }
{ const s = J("sk", "_te", "st_", r(24)); add("S25", "Stripe secret key (curl -u key:)", "credential", "claude", bash(`curl https://api.stripe.com/v1/charges -u ${s}:`), s); }
{ const s = J("sk", "-pr", "oj-", r(40)); add("S26", "OpenAI key env prefix", "credential", "claude", bash(`OPENAI_API_KEY=${s} node app.js`), s); }
{ const s = J("sk", "-an", "t-api03-", r(40)); add("S27", "Anthropic key as --api-key flag", "credential", "claude", bash(`claude --api-key ${s}`), s); }
{ const s = r(24); add("S28", "Slack incoming-webhook secret path (curl)", "credential", "claude", bash(`curl -X POST https://hooks.slack.com/services/T0AAAA/B0BBBB/${s}`), s); }
{ const s = b64(60); const kind = J("OPENSSH ", "PRIVATE", " KEY"); add("S29", "OpenSSH private key here-doc", "credential", "claude", bash(`cat > id_x <<EOF\n-----${J("BEG", "IN")} ${kind}-----\n${s}\n-----END ${kind}-----\nEOF`), s); }
{ const s = "Pw" + r(12); add("S30", ".env here-doc (DB_PASSWORD after the head)", "credential", "claude", bash(`cat > .env <<'EOF'\nDB_PASSWORD=${s}\nEOF`), s); }
{ const s = J("ey", "J", r(20), ".", J("ey", "J", r(30)), ".", r(30)); add("S31", "JWT in custom header", "credential", "claude", bash(`curl -H "X-Session: ${s}" https://api.example.test`), s); }
{ const s = J("gl", "pat-", r(20)); add("S32", "GitLab token PRIVATE-TOKEN header (wget)", "credential", "claude", bash(`wget --header="PRIVATE-TOKEN: ${s}" https://gitlab.example.test/api`), s); }
{ const s = J("hv", "s.", r(24)); add("S33", "Vault token as bare argv (vault login)", "credential", "claude", bash(`vault login ${s}`), s); }
{ const s = J("SG", ".", r(22), ".", r(20)); add("S34", "SendGrid-style key behind --key", "credential", "claude", bash(`mailer send --key ${s} --to ops`), s); }
{ const s = "Pw" + r(10); add("S35", "--password=<pw> flag", "credential", "claude", bash(`mysqladmin --password=${s} status`), s); }
{ const s = "Pw" + r(10); add("S36", "PowerShell ConvertTo-SecureString -AsPlainText", "credential", "claude", { tool_name: "PowerShell", tool_input: { command: `$p = ConvertTo-SecureString '${s}' -AsPlainText -Force` }, cwd: CWD }, s); }
{ const s = r(14); add("S37", "secret after the 64-char head (second simple command)", "credential", "claude", bash(`cd /srv/app && echo building && curl -H "X-Api-Key: ${s}" https://api.example.test`), s); }
{ const s = "Pw" + r(12); add("S16b", "redis://:password@ (empty username) as a bare argument", "credential", "claude", bash(`node worker.js redis://:${s}@cache.example.test:6379`), s); }
{ const s = "Pw" + r(10); add("S19b", "sudo docker login -p <password> (Monitor match -> notable)", "credential", "claude", bash(`sudo docker login -u bob -p ${s} reg.example.test`), s); }
{ const s = "Pw" + r(12); add("S38", "PowerShell $env:DB_PASSWORD = \"...\"", "credential", "claude", { tool_name: "PowerShell", tool_input: { command: `$env:DB_PASSWORD = "${s}"` }, cwd: CWD }, s); }
{ const s = r(30); add("S39", "PowerShell $env:SERVICE_KEY = '<unrecognised token>' (Codex)", "credential", "codex", { tool_name: "PowerShell", tool_input: { command: `$env:SERVICE_KEY = '${s}'` }, cwd: CWD }, s); }
{ const s = r(52, "abcdefghijklmnopqrstuvwxyz234567"); add("S40", "Azure DevOps PAT as userinfo in git push remote", "credential", "claude", bash(`git push https://${s}@dev.azure.com/org/p/_git/r feature-x`), s); }
{ const s = r(26); add("S41", "Cookie PHPSESSID= via curl -b", "credential", "claude", bash(`curl -b "PHPSESSID=${s}" https://app.example.test/`), s); }
{ const s = "Pw" + r(12); add("S42", "env prefix PASS= before a script", "credential", "claude", bash(`PASS=${s} ./deploy.sh`), s); }
// PowerShell's other ways of holding or setting a secret, a value piped into a secret reader, and a URL password with "@".
const ps = (command) => ({ tool_name: "PowerShell", tool_input: { command }, cwd: CWD });
{ const s = "Pw" + r(12); add("S43", "PowerShell $DbPass = '...' (plain variable)", "credential", "claude", ps(`$DbPass = '${s}'`), s); }
{ const s = "Pw" + r(12); add("S44", "PowerShell ConvertTo-SecureString -AsPlainText -Force -String '...'", "credential", "claude", ps(`$p = ConvertTo-SecureString -AsPlainText -Force -String '${s}'`), s); }
{ const s = "Pw" + r(12); add("S45", "PowerShell '...' | ConvertTo-SecureString (pipeline)", "credential", "claude", ps(`$p = '${s}' | ConvertTo-SecureString -AsPlainText -Force`), s); }
{ const s = r(32); add("S46", "PowerShell $apiKey = '<unrecognised token>'", "credential", "claude", ps(`$apiKey = '${s}'`), s); }
{ const s = r(24); add("S47", "PowerShell $token = '<unrecognised token>' (Codex)", "credential", "codex", ps(`$token = '${s}'`), s); }
{ const s = "Pw" + r(12); add("S48", "PowerShell $secret = \"...\"", "credential", "claude", ps(`$secret = "${s}"`), s); }
{ const s = r(32); add("S49", "PowerShell @{ Authorization = 'Bearer ...' }", "credential", "claude", ps(`$headers = @{ Authorization = 'Bearer ${s}' }`), s); }
{ const s = r(34); add("S50", "PowerShell @{ client_secret = '...' }", "credential", "claude", ps(`$body = @{ client_id = 'app'; client_secret = '${s}' }`), s); }
{ const s = "Pw" + r(12); add("S51", "PowerShell Set-Item Env:DB_PASSWORD '...'", "credential", "claude", ps(`Set-Item Env:DB_PASSWORD '${s}'`), s); }
{ const s = "Pw" + r(12); add("S52", "PowerShell [Environment]::SetEnvironmentVariable(\"DB_PASSWORD\", ...)", "credential", "claude", ps(`[Environment]::SetEnvironmentVariable("DB_PASSWORD", "${s}", "User")`), s); }
{ const s = "Pw" + r(12); add("S53", "PowerShell [Environment]::SetEnvironmentVariable('DB_PASSWORD','...') (no blanks)", "credential", "claude", ps(`[Environment]::SetEnvironmentVariable('DB_PASSWORD','${s}')`), s); }
{ const s = "Pw" + r(12); add("S54", "PowerShell New-Item -Path Env: -Name API_TOKEN -Value '...'", "credential", "claude", ps(`New-Item -Path Env: -Name API_TOKEN -Value '${s}'`), s); }
{ const s = "Pw" + r(12); add("S55", "PowerShell Set-Content Env:GH_TOKEN <pw>", "credential", "claude", ps(`Set-Content Env:GH_TOKEN ${s}`), s); }
{ const s = "Pw" + r(12); add("S56", "setx DB_PASSWORD <pw>", "credential", "claude", ps(`setx DB_PASSWORD ${s}`), s); }
{ const s = "Pw" + r(12); add("S57", "echo <pw> | docker login --password-stdin", "credential", "claude", bash(`echo "${s}" | docker login -u bob --password-stdin reg.example.test`), s); }
{ const s = r(14); add("S58", "git push URL whose password holds '@' (git.push params.remote)", "credential", "claude", bash(`git push https://bob:Pw@${s}@git.example.test/o/r.git main`), s); }
{ const s = r(14); add("S59", "curl URL whose password holds '@'", "credential", "claude", bash(`curl https://alice:se@${s}@api.example.test/v1/x`), s); }
// Non-shell tools
{ const s = J("AK", "IA", r(16, UPPER)); add("T01", "Write tool content holding a key", "credential", "claude", { tool_name: "Write", tool_input: { file_path: `${CWD}/config/aws.json`, content: `{"key":"${s}"}` }, cwd: CWD }, s); }
{ const s = "Pw" + r(14); add("T02", "Edit old_string/new_string with a password", "credential", "claude", { tool_name: "Edit", tool_input: { file_path: `${CWD}/.env.local`, old_string: "DB_PASSWORD=old", new_string: `DB_PASSWORD=${s}` }, cwd: CWD }, s); }
{ const s = r(30); add("T03", "WebFetch URL with token in query string", "credential", "claude", { tool_name: "WebFetch", tool_input: { url: `https://api.example.test/v1/data?token=${s}`, prompt: "x" }, cwd: CWD }, s); }
{ const s = "Pw" + r(10); add("T04", "WebFetch URL with user:password@", "credential", "claude", { tool_name: "WebFetch", tool_input: { url: `https://bob:${s}@intranet.example.test/wiki`, prompt: "x" }, cwd: CWD }, s); }
{ const s = r(24); add("T05", "WebFetch Slack webhook URL (secret in path)", "credential", "claude", { tool_name: "WebFetch", tool_input: { url: `https://hooks.slack.com/services/T0AAAA/B0BBBB/${s}`, prompt: "x" }, cwd: CWD }, s); }
{ const s = r(68); add("T06", "WebFetch Discord webhook URL (68-char token in path)", "credential", "claude", { tool_name: "WebFetch", tool_input: { url: `https://discord.com/api/webhooks/1234567890/${s}`, prompt: "x" }, cwd: CWD }, s); }
{ const s = J("12345678", ":", "AA", r(33)); add("T07", "WebFetch Telegram bot token in path", "credential", "claude", { tool_name: "WebFetch", tool_input: { url: `https://api.telegram.org/bot${s}/getUpdates`, prompt: "x" }, cwd: CWD }, s); }
{ const s = "Pw" + r(14); add("T08", "MCP tool args (SQL with password literal)", "credential", "claude", { tool_name: "mcp__postgres__query", tool_input: { sql: `ALTER USER app PASSWORD '${s}'` }, cwd: CWD }, s); }
{ const s = J("AK", "IA", r(16, UPPER)); add("T09", "Codex apply_patch body with a key", "credential", "codex", { tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Add File: config/keys.txt\n+${s}\n*** End Patch` }, cwd: CWD }, s); }
{ const s = r(32); add("T10", "Cursor beforeShellExecution Bearer", "credential", "cursor", { event: "beforeShellExecution", payload: { command: `curl -H "Authorization: Bearer ${s}" https://x.example.test`, cwd: CWD } }, s); }
{ const s = "Pw" + r(12); add("T11", "Cursor beforeMCPExecution args", "credential", "cursor", { event: "beforeMCPExecution", payload: { server: "db", tool: "login", args: { password: s } } }, s); }
{ const s = "Pw" + r(12); add("T12", "Grep tool pattern holding a secret (unknown tool)", "credential", "claude", { tool_name: "Grep", tool_input: { pattern: s, path: CWD }, cwd: CWD }, s); }
// Personal data
add("P01", "email in git commit --author", "pii", "claude", bash(`git commit --author "Jane Example <jane.example@example.com>" -m fix`), "jane.example@example.com");
add("P02", "email in git config user.email", "pii", "claude", bash(`git config user.email jane.example@example.com`), "jane.example@example.com");
add("P03", "email + phone in curl query", "pii", "claude", bash(`curl "https://crm.example.test/find?phone=+15555550100"`), "+15555550100");
add("P04", "patient name + SSN-shaped id in a Read path", "pii", "claude", { tool_name: "Read", tool_input: { file_path: "D:/records/patients/John_Doe_000-12-3456.pdf" }, cwd: CWD }, "John_Doe_000-12-3456");
add("P05", "OS user name in cwd (every shell receipt)", "pii", "claude", bash(`npm test`), "jane.example");
add("P06", "email in WebFetch path", "pii", "claude", { tool_name: "WebFetch", tool_input: { url: "https://crm.example.test/customers/jane.example@example.com/orders", prompt: "x" }, cwd: CWD }, "jane.example@example.com");
add("P07", "email in WebFetch query (dropped)", "pii", "claude", { tool_name: "WebFetch", tool_input: { url: "https://crm.example.test/find?email=mary.sample@example.com", prompt: "x" }, cwd: CWD }, "mary.sample@example.com");
add("P08", "customer name in Write path (inside folder)", "pii", "claude", { tool_name: "Write", tool_input: { file_path: `${CWD}/exports/Mary_Sample_medical_history.csv`, content: "x" }, cwd: CWD }, "Mary_Sample_medical_history");

add("P09", "customer name in a Write path OUTSIDE the folder (notable)", "pii", "claude", { tool_name: "Write", tool_input: { file_path: "D:/exports/Mary_Sample_medical_history.csv", content: "x" }, cwd: CWD }, "Mary_Sample_medical_history");
add("P10", "email in a destructive command (rm, Monitor match -> notable)", "pii", "claude", bash(`rm -f uploads/mary.sample@example.com.pdf`), "mary.sample@example.com");

// ---- helpers ---------------------------------------------------------------------------------------------------------
function mapOf(entry) {
  if (entry.harness === "codex") return mapCodexToolUse(entry.input);
  if (entry.harness === "cursor") return mapCursorEvent(entry.input.event, entry.input.payload);
  return mapClaudeToolUse(entry.input);
}
/** clear: whole secret present; partial: a 10-char window of it present; redacted: neither. */
function leak(text, secret) {
  if (text.includes(secret)) return "clear";
  for (let i = 0; i + 10 <= secret.length; i++) if (text.includes(secret.slice(i, i + 10))) return "partial";
  return "redacted";
}
/** JSON paths of strings carrying the secret (whole or partly). */
function pathsOf(value, secret, path = "$", out = []) {
  if (typeof value === "string") { if (leak(value, secret) !== "redacted") out.push(path); }
  else if (Array.isArray(value)) value.forEach((v, i) => pathsOf(v, secret, `${path}[${i}]`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) pathsOf(v, secret, `${path}.${k}`, out);
  return out;
}

function stubFetch(log) {
  return async (url, init = {}) => {
    const body = typeof init.body === "string" ? init.body : init.body ? Buffer.from(await new Response(init.body).arrayBuffer()).toString("utf8") : "";
    log.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body });
    if (String(url).endsWith("/v1/ingest") || String(url).endsWith("/v1/summaries")) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  };
}

const results = [];

test("no credential in the corpus leaves the computer (full or standard detail) or stays in the local store", async () => {
  for (const entry of corpus) {
    const dir = join(SANDBOX, entry.id, ".scopebond");
    scaffold(dir); // the shipped starter policy: Monitor by default
    writeFileSync(join(dir, "managed-meta.json"), JSON.stringify({ evidence_detail: "full" }));
    const log = [];
    const connection = {
      url: "https://cloud.invalid", credential: "sbm_corpus_fake", credential_id: "c", organization_id: "o", environment_id: "e",
      gateway_id: "g", attester_kid: "k", scopes: ["receipt:ingest"], expires_at: "2099-01-01T00:00:00.000Z",
    };
    const runtime = createHookRuntime({
      policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"),
      dbPath: join(dir, "receipts.db"), cwd: CWD, cloud: { connection, fetch: stubFetch(log) },
    });
    const mapped = mapOf(entry);
    const decision = await runtime.evaluate(mapped, { groupKey: `call-${entry.id}` });
    await runtime.exporter.flush();
    runtime.exporter.stop?.();
    const ingestBodies = log.filter((l) => l.url.endsWith("/v1/ingest")).map((l) => l.body);
    const ingestText = ingestBodies.join("\n");
    const receipts = ingestBodies.flatMap((b) => JSON.parse(b).receipts ?? []);
    // standard detail: notable receipts in full, routine ones only as a summary
    const notable = receipts.filter((x) => isNotable(x.payload));
    const routine = receipts.filter((x) => !isNotable(x.payload));
    let summaryText = "";
    if (routine.length) {
      const now = new Date();
      const summary = await buildSummary(routine, { attester: createAttester(), notableCount: notable.length, window: { kind: "interval", start: now.toISOString(), end: now.toISOString() } });
      summaryText = JSON.stringify(summary);
    }
    const standardText = JSON.stringify(notable) + "\n" + summaryText;
    // the one-line summary shown in the window and sent with "Ask an admin" (requests.json -> POST /v1/requests)
    const lines = receipts.map((x) => actionSummary(x.payload.intent));
    // local store: raw bytes of receipts.db (+ wal) and the outbox
    const localText = readdirSync(dir).filter((f) => /receipts\.db/.test(f)).map((f) => readFileSync(join(dir, f)).toString("latin1")).join("\n");
    results.push({
      id: entry.id, shape: entry.shape, kind: entry.kind, harness: entry.harness,
      action_types: mapped.map((m) => m.intent.action_type), decision: decision.decision,
      full: leak(ingestText, entry.secret), full_paths: [...new Set(receipts.flatMap((x, i) => pathsOf(x, entry.secret, `receipts[${i}]`)))].map((p) => p.replace(/receipts\[\d+\]/, "receipt")),
      notable: notable.length, routine: routine.length,
      standard: leak(standardText, entry.secret), summary_only: routine.length ? leak(summaryText, entry.secret) : "n/a",
      action_summary: leak(lines.join("\n"), entry.secret), action_summary_sample: lines.map((l) => l.replace(entry.secret, "<SECRET>")).slice(0, 2),
      local_store: leak(localText, entry.secret),
      params_sample: receipts.map((x) => JSON.stringify(x.payload.intent.params).split(entry.secret).join("<SECRET>")).slice(0, 3),
      top_level_keys: receipts[0] ? Object.keys(receipts[0].payload) : [],
    });
    assert.ok(receipts.length >= 1, `${entry.id}: at least one receipt POSTed to /v1/ingest`);
  }
  const leaks = results.filter((x) => x.kind === "credential" && (x.full !== "redacted" || x.standard !== "redacted" || x.local_store !== "redacted" || x.action_summary !== "redacted"))
    .map((x) => `${x.id} (${x.shape}): full=${x.full} standard=${x.standard} local=${x.local_store} summary=${x.action_summary} at ${x.full_paths.join(" ")}`);
  assert.deepEqual(leaks, []);
  // An email address in a fetched URL's path or query never leaves either.
  for (const id of ["P06", "P07"]) assert.equal(results.find((x) => x.id === id)?.full, "redacted", id);
});
