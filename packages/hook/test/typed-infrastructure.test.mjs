// Typed network, cloudflare_resource and database operations (MP11): derived from the actual
// command or WebFetch input, closed and schema-valid, keyed and free of raw values, honest
// when a fact cannot be read. POSIX and Windows/PowerShell shapes are covered, against real
// files in a temp directory.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindingKeyFromHex, classifySql, computeManifest, renderManifest, databaseGuardActions, defaultRules, compile, deriveTypedOperations, keyedIdFor, mapClaudeToolUse,
  callRequestOf, operationsForCall, parseDestination, redactCommand, useDigestKey, VECTORS, TYPED_ACTION_TYPES, mapCursorEvent, mapCodexToolUse,
} from "../dist/index.js";
import { operationProblem } from "./operation-schema.mjs";
import { ENFORCE } from "./enforce-all.mjs";

const KEY = bindingKeyFromHex("11".repeat(32));
useDigestKey("22".repeat(32));

const work = mkdtempSync(join(tmpdir(), "sb-infra-"));
const ctx = (over = {}) => ({ key: KEY, cwd: work, repositoryId: "sbr_repo", referenceSetVersion: "hook-1", env: () => undefined, ...over });

function derive(command, { tool = "Bash", context = ctx() } = {}) {
  const mapped = mapClaudeToolUse({ tool_name: tool, tool_input: { command }, cwd: context.cwd });
  const dispatched = mapped.map((m) => ({ action: { action_type: m.intent.action_type, params: m.intent.params } }));
  const typed = deriveTypedOperations({ command, dialect: tool === "PowerShell" ? "powershell" : "posix", dispatched, redact: redactCommand }, context);
  return { dispatched, typed };
}
const only = (command, opts) => {
  const { typed } = derive(command, opts);
  assert.equal(typed.size, 1, command);
  const op = [...typed.values()][0];
  assert.equal(operationProblem(op), null, `${command}: ${JSON.stringify(op)}`);
  return op;
};
const none = (command, opts) => assert.equal(derive(command, opts).typed.size, 0, command);

// ---- SQL classifier -------------------------------------------------------------------------------------

test("classifySql: verbs, bounded and unbounded predicates, and everything unreadable is null", () => {
  const c = (sql) => classifySql(sql);
  assert.deepEqual(c("SELECT * FROM users"), { verb: "read", predicate_class: "not_applicable", destructive: false });
  assert.equal(c("select 1; -- trailing").verb, "read");
  assert.equal(c("INSERT INTO t VALUES ('a;b', 2)").verb, "insert");
  assert.deepEqual(c("DELETE FROM t WHERE id = 7"), { verb: "delete", predicate_class: "bounded", destructive: false });
  assert.deepEqual(c("DELETE FROM t"), { verb: "delete_all", predicate_class: "all", destructive: true });
  assert.equal(c("DELETE FROM t WHERE 1=1").verb, "delete_all", "a tautology is not a predicate");
  assert.equal(c("DELETE FROM t WHERE true").verb, "delete_all");
  assert.equal(c("DELETE FROM t WHERE id = 1 OR 1=1").verb, "delete_all", "an OR is not shown to be selective");
  assert.equal(c("DELETE FROM t WHERE name LIKE '%'").verb, "delete_all");
  assert.equal(c("DELETE FROM t WHERE id IS NOT NULL").verb, "delete_all");
  assert.equal(c("DELETE FROM t WHERE created_at < now() AND status = 'old'").verb, "delete");
  assert.equal(c("DELETE FROM t WHERE id IN (SELECT id FROM u WHERE x = 1)").verb, "delete");
  assert.equal(c("DELETE FROM t WHERE id BETWEEN 1 AND 5").verb, "delete");
  assert.deepEqual(c("UPDATE t SET a = 1"), { verb: "update", predicate_class: "all", destructive: false });
  assert.equal(c("UPDATE t SET a = 1 WHERE id = 1").predicate_class, "bounded");
  assert.equal(c("TRUNCATE TABLE t").verb, "delete_all");
  assert.equal(c("DROP TABLE t").verb, "drop");
  assert.equal(c("CREATE INDEX i ON t (a)").verb, "create");
  const alter = c("ALTER TABLE t DROP COLUMN c");
  assert.equal(alter.verb, "alter");
  assert.equal(alter.destructive, true);
  assert.equal(c("ALTER TABLE t ADD COLUMN c int").destructive, false);
  assert.equal(c("BEGIN; DELETE FROM t WHERE id = 1; COMMIT;").verb, "delete", "transaction control is neutral");
  assert.equal(c("SELECT 1; DROP TABLE t").verb, "drop", "the most severe statement names the operation");
  assert.equal(c("DELETE FROM a WHERE id = 1; UPDATE b SET x = 1").predicate_class, "all", "the broadest predicate wins");
  assert.equal(c("SELECT * INTO copy FROM t").verb, "create");
  // A keyword inside a literal, a comment or a quoted identifier is not a statement.
  assert.equal(c("SELECT 'DROP TABLE t; DELETE FROM t'").verb, "read");
  assert.equal(c("SELECT 1 /* DROP TABLE t */").verb, "read");
  assert.equal(c('SELECT "drop" FROM t').verb, "read");
  // Unreadable: unknown statements, dynamic SQL, procedural blocks, unbalanced quotes, empty input.
  for (const sql of ["VACUUM FULL", "CALL purge()", "GRANT ALL ON t TO x", "MERGE INTO t USING u ON 1=1 WHEN MATCHED THEN DELETE", "DO $$ BEGIN DELETE FROM t; END $$", "WITH x AS (DELETE FROM t RETURNING *) SELECT 1",
    "SELECT 'unterminated", "SELECT 1 /* open", "", "  ;  ", "PRAGMA journal_mode = off", ".read evil.sql", "\\copy t to stdout", "EXPLAIN"]) {
    assert.equal(c(sql), null, sql);
  }
  assert.equal(c("EXPLAIN SELECT 1").verb, "read");
  assert.equal(c("EXPLAIN ANALYZE DELETE FROM t").verb, "delete_all", "EXPLAIN ANALYZE runs the statement");
});

// ---- network ------------------------------------------------------------------------------------------------

test("parseDestination: IDNA lowercase host, effective port, scheme; everything else is null", () => {
  assert.deepEqual(parseDestination("https://Example.COM/a/b?token=x#f", false), { scheme: "https", host: "example.com", port: 443 });
  assert.deepEqual(parseDestination("http://example.com:8080", false), { scheme: "http", host: "example.com", port: 8080 });
  assert.deepEqual(parseDestination("http://example.com:80/x", false), { scheme: "http", host: "example.com", port: 80 });
  assert.deepEqual(parseDestination("https://B\u00fcCHER.example/", false), { scheme: "https", host: "xn--bcher-kva.example", port: 443 });
  assert.deepEqual(parseDestination("https://user:secret@example.com/x", false), { scheme: "https", host: "example.com", port: 443 }, "credentials are dropped");
  assert.deepEqual(parseDestination("https://example.com./", false), { scheme: "https", host: "example.com", port: 443 });
  assert.deepEqual(parseDestination("example.com/x", true), { scheme: "http", host: "example.com", port: 80 }, "curl reads a bare host as http");
  assert.equal(parseDestination("example.com/x", false), null);
  for (const bad of ["ftp://example.com/f", "file:///etc/passwd", "https://[::1]/", "https://$HOST/x", "https://example.com/{a,b}", "https://exa mple.com", "", "//example.com", "https://example.com:99999/"]) {
    assert.equal(parseDestination(bad, true), null, bad);
  }
});

test("WebFetch derives a network read from the tool input; the URL path, query and credentials never appear", () => {
  const input = { tool_name: "WebFetch", tool_input: { url: "https://user:pw@Docs.Example.test:8443/secret/path?token=abc123&x=1" }, cwd: work };
  const mapped = mapClaudeToolUse(input);
  const dispatched = mapped.map((m) => ({ action: { action_type: m.intent.action_type, params: m.intent.params } }));
  const [op] = operationsForCall({ dispatched, request: callRequestOf(input) }, { key: KEY, cwd: work, repositoryId: "sbr_repo" });
  assert.equal(operationProblem(op), null);
  assert.deepEqual([op.scheme, op.host, op.port, op.method, op.net_operation], ["https", "docs.example.test", 8443, "GET", "read"]);
  const text = JSON.stringify(op);
  for (const raw of ["secret", "path", "token", "abc123", "user", "pw@"]) assert.ok(!text.includes(raw), `no ${raw}`);
  assert.equal("redirect_binding" in op, false, "a redirect hop is never bound");
  assert.equal(op.resource_id, keyedIdFor(KEY, "net-dest", ["docs.example.test", "8443"]));
  // A WebFetch without a URL, or with a scheme-less one, is not described.
  assert.equal(operationsForCall({ dispatched, request: callRequestOf({ ...input, tool_input: { url: "docs.example.test" } }) }, { key: KEY, cwd: work, repositoryId: "sbr_repo" })[0], null);
});

test("shell fetchers: method, operation class, host and port are read from the command", () => {
  const get = only("curl -s https://api.example.test/v1/items?token=abc123");
  assert.deepEqual([get.method, get.net_operation, get.host, get.port, get.scheme], ["GET", "read", "api.example.test", 443, "https"]);
  assert.equal(only("curl -sI https://example.test/").method, "HEAD");
  assert.equal(only("curl -X DELETE https://example.test/x/1").net_operation, "write");
  const post = only("curl -X POST -H 'Authorization: Bearer sk-live-abc123' -d @payload.json https://Example.Test:8443/upload");
  assert.deepEqual([post.method, post.net_operation, post.port], ["POST", "upload", 8443]);
  assert.equal(only("curl -d 'a=1' https://example.test/form").method, "POST", "a body implies POST");
  assert.equal(only("curl -T backup.tgz https://example.test/put").method, "PUT");
  assert.equal(only("curl -F file=@a.bin https://example.test/u").net_operation, "upload");
  assert.equal(only("curl -XPUT --data-binary @x https://example.test/x").method, "PUT", "an attached -X value");
  assert.equal(only("curl -G -d 'q=1' https://example.test/s").net_operation, "read", "-G makes the data a query");
  assert.equal(only("curl -X POST https://example.test/hook").net_operation, "write", "a POST with no body is a write, not an upload");
  assert.equal(only("curl example.test/x").scheme, "http");
  assert.equal(only("curl.exe -s https://example.test/x").method, "GET");
  const wget = only("wget --post-data='a=1' https://example.test/p");
  assert.deepEqual([wget.method, wget.net_operation], ["POST", "upload"]);
  assert.equal(only("wget -q -O out.bin https://example.test/f").net_operation, "read");
  assert.equal(only("wget --spider https://example.test/f").method, "HEAD");
  // -L follows redirects: the next hop is not bound, so nothing about it is claimed.
  assert.equal("redirect_binding" in only("curl -L https://example.test/r"), false);
  // Not extractable: no operation, the command stays a plain shell action.
  for (const command of ["curl https://a.test/x https://b.test/y", "curl -x http://proxy.test:3128 https://a.test/x", "curl --resolve a.test:443:1.2.3.4 https://a.test/x", "curl -K cfg https://a.test", "curl $URL",
    "curl ftp://a.test/f", "curl -X PROPFIND https://a.test/", "curl http://[::1]:8080/", "curl -sX https://a.test/x", "wget -i urls.txt", "curl --unix-socket /var/run/d.sock http://localhost/x", "curl -s"]) none(command);
  assert.equal(derive("cd sub && curl https://a.test/x").typed.size, 1, "the destination of a fetch does not depend on the workspace");
  assert.equal(derive("cd sub && wrangler deploy --name w").typed.size, 0, "a config or file read after a cd would describe the wrong directory");
});

test("PowerShell fetchers: cmdlets and aliases read -Uri, -Method, -Body and -InFile", () => {
  const ps = (command) => only(command, { tool: "PowerShell", context: ctx({ cwd: "C:\\w" }) });
  assert.deepEqual([ps("Invoke-WebRequest https://Example.test/x").method, ps("iwr -Uri https://example.test/x -UseBasicParsing").net_operation], ["GET", "read"]);
  const post = ps("Invoke-RestMethod -Uri https://example.test:8443/api -Method Post -Body $payload -ContentType application/json");
  assert.deepEqual([post.method, post.net_operation, post.port], ["POST", "upload", 8443]);
  assert.equal(ps("irm https://example.test/x -Method Put -InFile C:\\data\\a.bin").method, "PUT");
  assert.equal(ps("Invoke-WebRequest -Uri https://example.test/x -Method Delete").net_operation, "write");
  assert.equal(ps("curl https://example.test/x").method, "GET", "in PowerShell curl is Invoke-WebRequest");
  assert.equal(ps("curl.exe -s -X POST -d a=1 https://example.test/x").net_operation, "upload");
  none("Invoke-WebRequest -Uri https://example.test/x -Proxy http://p.test:8080", { tool: "PowerShell" });
  none("Invoke-WebRequest -Uri $u", { tool: "PowerShell" });
  none("Invoke-WebRequest -Uri https://example.test/x -Method Merge", { tool: "PowerShell" });
});

// ---- cloudflare_resource ----------------------------------------------------------------------------------

test("wrangler: resource kind, verb, keyed account and resource ids, environment class", () => {
  const deploy = only("wrangler deploy --name my-worker --env production");
  assert.deepEqual([deploy.type, deploy.resource_kind, deploy.verb, deploy.environment_class], ["cloudflare_resource", "worker", "update", "production"]);
  assert.equal(deploy.resource_id, keyedIdFor(KEY, "cf", ["worker", "my-worker"]));
  assert.equal(deploy.environment_binding, KEY.resourceId("cf:env", "production"));
  assert.equal(deploy.account_id, "unbound", "an account that cannot be read is reported unbound, not guessed");
  assert.equal(only("wrangler deploy --name w --env staging").environment_class, "staging");
  assert.equal(only("wrangler deploy --name w --env qa-7").environment_class, "unknown");
  assert.equal(only("wrangler deploy --name w").environment_class, "unknown");
  assert.equal(only("wrangler delete --name old-worker").verb, "delete");
  assert.equal(only("npx wrangler deploy --name w").resource_kind, "worker", "through npx");
  assert.equal(only("npx -y wrangler@3.90.0 deploy --name w").resource_kind, "worker");
  assert.equal(only("pnpm exec wrangler deploy --name w").resource_kind, "worker");
  assert.equal(only("npm exec -- wrangler deploy --name w").resource_kind, "worker");
  assert.equal(only("wrangler.exe deploy --name w").resource_kind, "worker", "a Windows spelling");
  assert.equal(only("wrangler d1 create app-db").resource_kind, "d1_database");
  assert.equal(only("wrangler d1 delete app-db -y").verb, "delete");
  assert.equal(only("wrangler pages project create site").resource_kind, "pages_project");
  assert.equal(only("wrangler pages project delete site").verb, "delete");
  const bucket = only("wrangler r2 bucket delete backups --jurisdiction eu");
  assert.deepEqual([bucket.resource_kind, bucket.verb], ["r2_bucket", "delete"]);
  assert.equal(bucket.resource_id, keyedIdFor(KEY, "cf", ["r2_bucket", "backups"]));
  const pub = only("wrangler r2 bucket dev-url enable backups");
  assert.deepEqual([pub.verb, pub.visibility_before, pub.visibility_after], ["set_visibility", "unknown", "public"]);
  assert.equal(only("wrangler r2 bucket dev-url disable backups").visibility_after, "private");
  const del = only("wrangler r2 object delete backups/2026/db.sql.gz");
  assert.deepEqual([del.resource_kind, del.verb], ["r2_object", "delete"]);
  // Not described: dry runs, help, unknown flags (they could take a value and shift the arguments), other commands.
  none("wrangler deploy --dry-run");
  none("wrangler deploy --frobnicate now --name w");
  none("wrangler whoami");
  none("wrangler kv namespace delete --namespace-id abc");
  none("wrangler pages deploy");
  none("npx some-other-tool deploy");
});

test("wrangler: the account and worker name come from inline assignment, the config file or the environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-wr-"));
  writeFileSync(join(dir, "wrangler.toml"), 'name = "toml-worker"\naccount_id = "acct-from-toml"\n\n[env.production]\nname = "toml-worker-live"\n');
  const c = ctx({ cwd: dir });
  const base = only("wrangler deploy", { context: c });
  assert.equal(base.resource_id, KEY.resourceId("cf:worker", "toml-worker"));
  assert.equal(base.account_id, KEY.resourceId("cf:account", "acct-from-toml"));
  assert.equal(only("wrangler deploy --env production", { context: c }).resource_id, KEY.resourceId("cf:worker", "toml-worker-live"));
  assert.equal(only("wrangler deploy --env staging", { context: c }).resource_id, KEY.resourceId("cf:worker", "toml-worker-staging"), "wrangler's own suffix rule");
  assert.equal(only("CLOUDFLARE_ACCOUNT_ID=acct-inline wrangler deploy", { context: c }).account_id, KEY.resourceId("cf:account", "acct-inline"));
  const jdir = mkdtempSync(join(tmpdir(), "sb-wr-"));
  writeFileSync(join(jdir, "wrangler.jsonc"), '{\n // comment\n "name": "json-worker", "account_id": "acct-json", /* c */ "env": { "production": { "name": "json-live" } },\n}');
  assert.equal(only("wrangler deploy", { context: ctx({ cwd: jdir }) }).resource_id, KEY.resourceId("cf:worker", "json-worker"));
  assert.equal(only("wrangler deploy --env production", { context: ctx({ cwd: jdir }) }).resource_id, KEY.resourceId("cf:worker", "json-live"));
  const bare = ctx({ env: (n) => (n === "CLOUDFLARE_ACCOUNT_ID" ? "acct-env" : undefined) });
  assert.equal(only("wrangler deploy --name w", { context: bare }).account_id, KEY.resourceId("cf:account", "acct-env"));
  // A worker whose name cannot be read is bound to nothing, under an id no reference set matches.
  const unnamed = only("wrangler deploy", { context: ctx({ cwd: mkdtempSync(join(tmpdir(), "sb-wr-")) }) });
  assert.equal(unnamed.resource_id, KEY.resourceId("cf:worker", "\0unbound"));
  // The raw account never appears.
  assert.ok(!JSON.stringify(base).includes("acct-from-toml"));
});

test("wrangler pages deploy and r2 object put carry a digest of what is sent", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-pages-"));
  mkdirSync(join(dir, "dist", "assets"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.html"), "<h1>hello</h1>");
  writeFileSync(join(dir, "dist", "assets", "a.js"), "console.log(1)");
  writeFileSync(join(dir, "backup.bin"), "backup-bytes");
  const c = ctx({ cwd: dir });
  const first = only("wrangler pages deploy dist --project-name site --branch main", { context: c });
  assert.deepEqual([first.resource_kind, first.verb], ["pages_deployment", "create"]);
  assert.match(first.artifact_digest, /^[0-9a-f]{64}$/);
  assert.equal(first.resource_id, KEY.resourceId("cf:pages_deployment", "site"));
  assert.equal(first.environment_binding, KEY.resourceId("cf:pages-branch", "main"));
  assert.equal(only("wrangler pages deploy dist --project-name site", { context: c }).artifact_digest, first.artifact_digest, "stable");
  writeFileSync(join(dir, "dist", "assets", "a.js"), "console.log(2)");
  assert.notEqual(only("wrangler pages deploy dist --project-name site", { context: c }).artifact_digest, first.artifact_digest, "a changed file changes the digest");
  const put = only("wrangler r2 object put backups/db.bin --file backup.bin", { context: c });
  assert.deepEqual([put.resource_kind, put.verb], ["r2_object", "write"]);
  assert.match(put.artifact_digest, /^[0-9a-f]{64}$/);
  assert.equal("artifact_digest" in only("wrangler r2 object put backups/x --file missing.bin", { context: c }), false, "an unreadable file is not digested");
  assert.equal("artifact_digest" in only("wrangler pages deploy missing-dir --project-name site", { context: c }), false, "an unreadable directory is not digested");
  none("wrangler pages deploy --project-name site", { context: c });
  // Windows: PowerShell spelling and drive-letter paths.
  const w = only("wrangler pages deploy dist --project-name site", { tool: "PowerShell", context: c });
  assert.equal(w.resource_kind, "pages_deployment");
});

// ---- database -------------------------------------------------------------------------------------------------

test("wrangler d1 execute and migrations: verb, predicate class, keyed database id, keyed digest; no SQL", () => {
  const remote = only('wrangler d1 execute prod-db --remote --command "DELETE FROM accounts WHERE email = \'jane.doe@example.com\'"');
  assert.deepEqual([remote.type, remote.provider, remote.verb, remote.predicate_class, remote.reviewed_destructive], ["database", "cloudflare_d1", "delete", "bounded", false]);
  assert.equal(remote.database_id, keyedIdFor(KEY, "cf", ["d1_database", "prod-db"]), "the same id as the cloudflare_resource for that database");
  assert.equal(remote.resource_id, remote.database_id);
  assert.match(remote.migration_digest, /^[0-9a-f]{64}$/);
  assert.equal(only('wrangler d1 execute prod-db --remote --command "DELETE FROM accounts"').verb, "delete_all");
  assert.equal(only('wrangler d1 execute prod-db --remote --command "DROP TABLE accounts"').verb, "drop");
  assert.equal(only('wrangler d1 execute prod-db --local --command "SELECT * FROM accounts"').environment_class, "development");
  assert.equal("migration_digest" in only('wrangler d1 execute prod-db --local --command "SELECT 1"'), false, "no digest for a read");
  const a = only('wrangler d1 execute db --remote --command "UPDATE t SET a = 1 WHERE id = 1"').migration_digest;
  const b = only('wrangler d1 execute db --remote --command "UPDATE t SET a = 1 WHERE id = 2"').migration_digest;
  assert.notEqual(a, b);
  assert.equal(only('wrangler d1 execute db --remote --command "UPDATE t SET a = 1 WHERE id = 1"').migration_digest, a, "deterministic under one key");
  assert.notEqual(bindingKeyFromHex("33".repeat(32)).requestDigest({ domain: "sql", input: { sql: "UPDATE t SET a = 1 WHERE id = 1" } }), a, "keyed: another installation cannot reproduce it");
  // --file: read locally, classified, digested; the text does not leave.
  const dir = mkdtempSync(join(tmpdir(), "sb-d1-"));
  writeFileSync(join(dir, "purge.sql"), "-- purge\nDELETE FROM sessions;\n");
  const file = only("wrangler d1 execute db --remote --file purge.sql", { context: ctx({ cwd: dir }) });
  assert.equal(file.verb, "delete_all");
  none("wrangler d1 execute db --remote --file missing.sql", { context: ctx({ cwd: dir }) });
  // Migrations: the local migration set is digested; its statements decide the risk, not the verb.
  mkdirSync(join(dir, "migrations"));
  writeFileSync(join(dir, "migrations", "0001_init.sql"), "CREATE TABLE t (id INTEGER);");
  writeFileSync(join(dir, "migrations", "0002_drop.sql"), "DROP TABLE legacy;");
  const mig = only("wrangler d1 migrations apply db --remote", { context: ctx({ cwd: dir }) });
  assert.deepEqual([mig.verb, mig.predicate_class], ["migrate", "not_applicable"]);
  assert.match(mig.migration_digest, /^[0-9a-f]{64}$/);
  writeFileSync(join(dir, "migrations", "0003_more.sql"), "CREATE TABLE u (id INTEGER);");
  assert.notEqual(only("wrangler d1 migrations apply db --remote", { context: ctx({ cwd: dir }) }).migration_digest, mig.migration_digest);
  none("wrangler d1 migrations apply db", { context: ctx({ cwd: mkdtempSync(join(tmpdir(), "sb-d1-")) }) });
  // Not described: no statement, both a command and a file, SQL the classifier cannot place.
  none("wrangler d1 execute db --remote");
  none('wrangler d1 execute db --remote --command "SELECT 1" --file x.sql');
  none('wrangler d1 execute db --remote --command "VACUUM FULL"');
  none('wrangler d1 execute db --remote --local --command "SELECT 1"');
});

test("psql and sqlite3: provider, verb, predicate class and keyed database id; credentials and hosts never appear", () => {
  const pg = only('psql "postgresql://admin:hunter2-pw@db.prod.example.com:6432/app?sslmode=require" -c "TRUNCATE orders"');
  assert.deepEqual([pg.provider, pg.verb, pg.predicate_class], ["postgres", "delete_all", "all"]);
  assert.equal(pg.database_id, keyedIdFor(KEY, "database", ["pg", "db.prod.example.com:6432/app"]));
  assert.equal(only("psql -h DB.prod.example.com -p 6432 -d app -U someone -c 'select 1'").database_id.length > 4, true);
  assert.equal(only("psql -h db.prod.example.com -p 6432 -d app -c 'SELECT 1'").database_id, keyedIdFor(KEY, "database", ["pg", "db.prod.example.com:6432/app"]), "URI and flags name the same database");
  assert.equal(only("psql -h localhost -d dev -c 'SELECT 1'").environment_class, "development");
  assert.equal(only("psql -h db.example.com -d x -c 'SELECT 1'").environment_class, "unknown");
  assert.equal(only("psql -h db.example.com -d x --command=\"DELETE FROM t WHERE id = 3\"").predicate_class, "bounded");
  assert.equal(only("psql -h db.example.com -d x -cDROP\\ TABLE\\ t").verb, "drop", "an attached -c value");
  none("psql -h db.example.com -d x", {});
  none("psql -h db.example.com -d x -c 'CALL purge()'");
  none("psql -h db.example.com -d x -f -");
  none("psql -h db.example.com -d x -c '\\copy t to stdout'");
  const lite = only('sqlite3 data/app.db "DELETE FROM t WHERE id = 1"');
  assert.deepEqual([lite.provider, lite.verb, lite.predicate_class], ["sqlite", "delete", "bounded"]);
  assert.equal(only('sqlite3 :memory: "SELECT 1"').environment_class, "development");
  assert.equal(only('sqlite3 -cmd "DROP TABLE t" app.db "SELECT 1"').verb, "drop", "-cmd runs SQL too");
  none("sqlite3 app.db");
  none("sqlite3 -init setup.sql app.db 'SELECT 1'");
  // Windows spelling.
  assert.equal(only('sqlite3.exe app.db "SELECT 1"', { tool: "PowerShell", context: ctx({ cwd: "C:\\w" }) }).provider, "sqlite");
  assert.equal(only('psql.exe -h localhost -d d -c "SELECT 1"', { tool: "PowerShell", context: ctx({ cwd: "C:\\w" }) }).provider, "postgres");
});

// ---- privacy canaries -----------------------------------------------------------------------------------------

test("privacy canaries: no SQL text, rows, names, credentials, paths, queries or bodies in any operation", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-canary-"));
  writeFileSync(join(dir, "seed.sql"), "INSERT INTO customers VALUES ('CANARY-ROW-jane.doe@example.com', 'CANARY-SSN-123-45-6789');");
  const commands = [
    "wrangler d1 execute CANARY-DB --remote --command \"DELETE FROM CANARY_TABLE WHERE email = 'CANARY-ROW-x@example.com' AND card = 'CANARY-CARD-4111'\"",
    "wrangler d1 execute CANARY-DB --remote --file seed.sql",
    "psql postgresql://CANARY-USER:CANARY-PASS@CANARY-host.example.com/CANARY-DBNAME -c \"UPDATE CANARY_TABLE SET token = 'CANARY-SECRET' WHERE id = 1\"",
    "sqlite3 CANARY-file.db \"INSERT INTO CANARY_TABLE VALUES ('CANARY-ROW')\"",
    "curl -X POST -H 'Authorization: Bearer CANARY-BEARER' -d 'CANARY-BODY=1' 'https://CANARY-user:CANARY-pw@api.example.test/CANARY-path?token=CANARY-QUERY'",
    "wget --post-data='CANARY-BODY' https://api.example.test/CANARY-path?key=CANARY-QUERY",
    "CLOUDFLARE_ACCOUNT_ID=CANARY-ACCOUNT wrangler r2 object put CANARY-bucket/CANARY-key --file seed.sql",
    "CLOUDFLARE_ACCOUNT_ID=CANARY-ACCOUNT wrangler deploy --name CANARY-worker --env CANARY-env",
  ];
  const ops = commands.map((c) => only(c, { context: ctx({ cwd: dir }) }));
  const web = operationsForCall({ dispatched: [{ action: { action_type: "net.fetch", params: { host: "x", path: "/", method: "GET" } } }], request: { fetch: { url: "https://api.example.test/CANARY-path?token=CANARY-QUERY" } } }, { key: KEY, cwd: dir, repositoryId: "sbr_repo" });
  ops.push(web[0]);
  assert.equal(ops.length, commands.length + 1);
  const text = JSON.stringify(ops);
  assert.ok(!/CANARY/i.test(text), `a canary leaked: ${text.match(/.{20}CANARY.{20}/i)?.[0]}`);
  for (const op of ops) assert.equal(operationProblem(op), null);
  // Only the schema's own keys exist: nothing like sql, statement, query, body, path or rows.
  for (const op of ops) for (const key of Object.keys(op)) assert.ok(!/(?:sql|statement|query|body|path|row|header|credential|password|token|secret)|(?:name$)/i.test(key), key);
});

// ---- dispatch integration and manifest ---------------------------------------------------------------------------

test("operationsForCall gives the typed operation for the shell item and keeps plain operations for the rest", () => {
  const command = "wrangler r2 bucket delete backups && ls";
  const mapped = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command }, cwd: work });
  const dispatched = mapped.map((m) => ({ action: { action_type: m.intent.action_type, params: m.intent.params } }));
  const ops = operationsForCall({ dispatched, request: callRequestOf({ tool_name: "Bash", tool_input: { command } }) }, { key: KEY, cwd: work, repositoryId: "sbr_repo", env: () => undefined });
  assert.deepEqual(ops.map((o) => o?.type), ["cloudflare_resource", "shell"]);
  assert.equal(ops[0].request_digest, KEY.requestDigest({ action_type: "shell.exec", params: { command: "wrangler r2 bucket delete backups", cwd: work } }), "the digest covers the actual command");
});

test("Codex and Cursor derive the same operations from their shell events", () => {
  const cursor = mapCursorEvent("beforeShellExecution", { command: "curl -s https://example.test/x", cwd: work });
  const codex = mapCodexToolUse({ tool_name: "Bash", tool_input: { command: "curl -s https://example.test/x" }, cwd: work });
  for (const mapped of [cursor, codex]) {
    const dispatched = mapped.map((m) => ({ action: { action_type: m.intent.action_type, params: m.intent.params } }));
    const typed = deriveTypedOperations({ command: "curl -s https://example.test/x", dispatched, redact: redactCommand }, ctx());
    assert.equal([...typed.values()][0].type, "network");
  }
});

const TYPED = ["network.request", "cloudflare.resource", "database.exec"];
const UNSUPPORTED = ["browser.action", "communication.send", "visibility.change"];

test("manifest: network, cloudflare and database cells are observation-only and unverified; browser, communication and visibility are unsupported with a reason", () => {
  const manifest = computeManifest({ adapterVersion: "0.0.0-test", configured: { claude: true, codex: true, cursor: true } });
  for (const type of TYPED) {
    const cells = manifest.cells.filter((c) => c.action_type === type);
    assert.equal(cells.length, 5, `${type}: two Claude, two Codex and one Cursor host variant`);
    for (const cell of cells) {
      assert.equal(cell.state, "configured_unverified", `${type} ${cell.host_variant}: a fixture never makes a cell verified`);
      assert.equal(cell.observation_only, true);
      assert.equal(cell.boundary, "none");
      assert.ok(cell.test_vector_digest, "vectors exist");
      assert.ok(cell.emitted_required_fields.length > 0);
    }
  }
  const network = manifest.cells.filter((c) => c.action_type === "network.request");
  assert.equal((renderManifest(manifest).match(/and WebFetch]/g) ?? []).length, 2, "only the two Claude Code hosts carry WebFetch; Codex and Cursor have no fetch hook");
  assert.ok(network.length === 5);
  for (const type of UNSUPPORTED) {
    for (const cell of manifest.cells.filter((c) => c.action_type === type)) {
      assert.equal(cell.state, "unsupported", `${type} ${cell.host_variant}`);
      assert.match(cell.reason, /no |only as generic MCP|not/i);
      assert.equal(cell.test_vector_digest, null);
      assert.deepEqual(cell.supported_operations, []);
    }
  }
  const reasons = Object.fromEntries(UNSUPPORTED.map((t) => [t, manifest.cells.find((c) => c.action_type === t).reason]));
  assert.match(reasons["browser.action"], /generic MCP tool call with no origin, verb or action class/);
  assert.match(reasons["communication.send"], /destination domain or channel/);
  assert.match(reasons["visibility.change"], /before and after/);
  for (const type of [...TYPED, ...UNSUPPORTED]) assert.ok(TYPED_ACTION_TYPES.has(type), `${type} is an observation cell, not a receipt cell`);
});

test("browser and communication tools stay generic MCP operations: no browser or communication operation is derived from them", () => {
  const tools = [
    ["mcp__claude-in-chrome__navigate", { url: "https://bank.example.test/account?id=1" }],
    ["mcp__claude-in-chrome__computer", { action: "screenshot" }],
    ["mcp__slack__post_message", { channel: "C0123", text: "CANARY message text" }],
    ["mcp__gmail__send_email", { to: "CANARY.local-part@example.test", body: "CANARY body", attachments: ["CANARY.pdf"] }],
  ];
  for (const [tool_name, tool_input] of tools) {
    const input = { tool_name, tool_input, cwd: work };
    const dispatched = mapClaudeToolUse(input).map((m) => ({ action: { action_type: m.intent.action_type, params: m.intent.params } }));
    const [op] = operationsForCall({ dispatched, request: callRequestOf(input) }, { key: KEY, cwd: work, repositoryId: "sbr_repo" });
    assert.equal(op.type, "mcp", tool_name);
    assert.equal(op.operation_class, "unknown", `${tool_name} is not classified as a read or a mutation`);
    assert.ok(!/CANARY|bank\.example|C0123/.test(JSON.stringify(op)), "nothing of the request leaks");
  }
});

test("every new vector derives its operation and the default policy allows it", () => {
  const cells = new Set([...TYPED]);
  const vectors = VECTORS.filter((v) => v.cell && cells.has(v.cell.action_type));
  assert.ok(vectors.length >= 12);
  for (const type of TYPED) for (const agent of ["claude", "codex", "cursor"]) assert.ok(vectors.some((v) => v.cell.action_type === type && v.agent === agent), `${type} has a ${agent} vector`);
  for (const v of vectors) {
    assert.equal(v.expect, "allow");
    assert.ok(v.typed?.type, v.id);
  }
});

// ---- opt-in enforcement -------------------------------------------------------------------------------------------

test("protect_remote_database: off by default; when on, the compiled policy has the clause and remote destructive SQL is classified risky", () => {
  const off = compile({ ...defaultRules(), ...ENFORCE }, "kid");
  assert.equal(off.clauses.some((c) => c.id === "protect-remote-database"), false, "the starter policy is unchanged");
  const on = compile({ ...defaultRules(), protect_remote_database: true }, "kid");
  const clause = on.clauses.find((c) => c.id === "protect-remote-database");
  assert.equal(clause.mode, "enforce");
  assert.deepEqual(clause.action_types, ["db.exec"]);
  assert.equal(clause.param_bounds.risk.pattern, "^ordinary$");
  const guard = (command, dialect = "posix") => databaseGuardActions(command, dialect, { cwd: work, env: () => undefined });
  assert.deepEqual(guard('wrangler d1 execute prod --remote --command "DROP TABLE users"').map((a) => a.risk), ["destructive"]);
  assert.deepEqual(guard('wrangler d1 execute prod --remote --command "DELETE FROM users"').map((a) => a.risk), ["destructive"]);
  assert.deepEqual(guard('wrangler d1 execute prod --remote --command "UPDATE users SET a = 1"').map((a) => a.risk), ["destructive"]);
  assert.deepEqual(guard('wrangler d1 execute prod --remote --command "DELETE FROM users WHERE id = 1"').map((a) => a.risk), ["ordinary"]);
  assert.deepEqual(guard('wrangler d1 execute prod --remote --command "SELECT 1"').map((a) => a.risk), ["ordinary"]);
  assert.deepEqual(guard('wrangler d1 execute prod --local --command "DROP TABLE users"'), [], "a local database is not the remote one");
  assert.deepEqual(guard('psql -h localhost -d d -c "DROP TABLE t"'), []);
  assert.deepEqual(guard('psql -h db.example.com -d d -c "DROP TABLE t"').map((a) => a.risk), ["destructive"]);
  assert.deepEqual(guard('wrangler d1 execute prod --remote --command "VACUUM FULL"').map((a) => a.risk), ["unknown"], "SQL that cannot be read is not waved through");
  assert.deepEqual(guard("ls -la"), []);
  assert.deepEqual(guard('Invoke-Expression "x"', "powershell"), []);
  // The action carries no SQL.
  assert.deepEqual(Object.keys(guard('wrangler d1 execute prod --remote --command "DROP TABLE secret_table"')[0]).sort(), ["provider", "risk", "scope", "verb"]);
  assert.ok(!JSON.stringify(guard('wrangler d1 execute prod --remote --command "DROP TABLE secret_table"')).includes("secret_table"));
});

test("end to end: with the rule on, the hook denies a remote DROP before it runs and allows the rest; off, nothing changes", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { scaffold } = await import("../dist/index.js");
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "sb-guard-"));
  scaffold(dir, ENFORCE);
  const env = { ...process.env, SCOPEBOND_HOOK_DIR: dir, HOME: dir, USERPROFILE: dir };
  const run = (args, input) => spawnSync(process.execPath, [cli, ...args], { input, encoding: "utf8", env, cwd: dir, timeout: 60000 });
  const bash = (command) => JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: dir });
  const drop = 'wrangler d1 execute prod-db --remote --command "DROP TABLE users"';
  assert.equal(run(["claude"], bash(drop)).status, 0, "off by default: the starter policy does not cover it");
  const on = run(["rules", "protect-remote-database", "--yes"]);
  assert.equal(on.status, 0, on.stderr);
  const denied = run(["claude"], bash(drop));
  assert.equal(denied.status, 2, "denied before it runs");
  assert.match(denied.stderr, /protect-remote-database/);
  assert.ok(!denied.stderr.includes("users"), "the SQL is not echoed");
  assert.equal(run(["claude"], bash('wrangler d1 execute prod-db --remote --command "SELECT 1"')).status, 0);
  assert.equal(run(["claude"], bash('wrangler d1 execute prod-db --remote --command "DELETE FROM users WHERE id = 1"')).status, 0);
  assert.equal(run(["claude"], bash('wrangler d1 execute prod-db --remote --command "DELETE FROM users"')).status, 2);
  assert.equal(run(["claude"], bash('wrangler d1 execute prod-db --local --command "DROP TABLE users"')).status, 0, "a local database is not the remote one");
  assert.equal(run(["codex"], JSON.stringify({ tool_name: "Bash", tool_input: { command: 'psql -h db.example.com -d app -c "TRUNCATE orders"' }, cwd: dir })).status, 0, "Codex answers a deny on exit 0 with a deny decision");
  const codex = run(["codex"], JSON.stringify({ tool_name: "Bash", tool_input: { command: 'psql -h db.example.com -d app -c "TRUNCATE orders"' }, cwd: dir }));
  assert.equal(JSON.parse(codex.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(run(["rules", "unprotect-remote-database", "--yes"]).status, 0);
  assert.equal(run(["claude"], bash(drop)).status, 0);
});
