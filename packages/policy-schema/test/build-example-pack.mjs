// Builds vectors/example-pack.json: a small public rule pack that exercises every part of the pack format with generic,
// made-up tools (`examplectl`, `exampledeploy`) and MCP servers (`exampletracker`, `examplefs`, `exampledb`). It is
// signed with a TEST-ONLY key derived from a published seed, so anyone can rebuild it byte for byte; no engine trusts that
// key unless a test passes it in. Run from this package: `node test/build-example-pack.mjs` (after `pnpm build`).
//
// The vectors' expected actions are what the hook's interpreter derives (packages/hook/src/packs.ts); the hook's tests run
// them, and so can any other engine that implements the format.

import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { packSigningInput, validatePack } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The test-only signing key: Ed25519 from the SHA-256 of a published phrase. Never a real key. */
export function testPackKey() {
  const seed = createHash("sha256").update("scopebond pack format test vectors (test only, never trusted)").digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, key_id: "pack-test-vectors", public_key: publicKey.export({ format: "pem", type: "spki" }) };
}

const c = (v) => ({ const: v });
const flag = (...names) => ({ flag: names });
const pos = (i) => ({ positional: i });
const destructive = c("destructive");
const sensitive = c("sensitive");

const grammars = [
  {
    id: "examplectl",
    programs: ["examplectl"],
    options: {
      valued: ["--region", "-r", "--profile", "--env", "-e", "--name", "-n", "--command", "--file", "-X", "--method", "--to"],
      flags: ["--yes", "-y", "--force", "--recursive", "--local", "--remote"],
    },
    strip_words: ["beta"],
    skip: { options: ["--help", "-h", "--dry-run"], words: ["help"] },
    commands: [
      // Listing and reading derive nothing, even with an option the grammar does not know.
      { path: [{ any: ["list", "get", "describe"] }], emit: [] },
      {
        path: ["bucket", { any: ["delete", "rm"] }],
        emit: [{ action_type: "cloud.resource.delete", params: {
          provider: c("unknown"), service: c("storage"), kind: c("bucket"),
          region: { ident: { first: [flag("--region", "-r"), { assign: "EXAMPLE_REGION" }] } },
          env: { env_of: { first: [flag("--profile"), { assign: "EXAMPLE_PROFILE" }] } },
          resource_digest: { digest: ["example", "storage", { match: pos(0), pattern: "^ex://([^/]+)", group: 1 }] },
          auto_approve: { present: ["--yes", "-y", "--force"] },
          risk_class: destructive,
        } }],
      },
      {
        // `examplectl delete-volume NAME`, `create-volume`, `update-volume`: the verb and kind from one word.
        path: [{ pattern: "^(?:create|delete|update)-[a-z][a-z-]*$", var: "op" }],
        emit: [{ action_type: "cloud.resource.delete", when: { matches: [{ var: "op" }, "^delete-"] }, params: {
          provider: c("unknown"), service: c("compute"), kind: { match: { var: "op" }, pattern: "^delete-(.+)$", group: 1 },
          resource_digest: { digest: ["example", "compute", pos(0)] }, risk_class: destructive,
        } }, { action_type: "cloud.resource.create", when: { matches: [{ var: "op" }, "^create-"] }, params: {
          provider: c("unknown"), service: c("compute"), kind: { match: { var: "op" }, pattern: "^create-(.+)$", group: 1 }, risk_class: sensitive,
        } }, { action_type: "cloud.resource.modify", when: { matches: [{ var: "op" }, "^update-"] }, params: {
          provider: c("unknown"), service: c("compute"), kind: { match: { var: "op" }, pattern: "^update-(.+)$", group: 1 }, risk_class: sensitive,
        } }],
      },
      {
        // `examplectl net firewall rule rm NAME`: any group of up to three words before the verb.
        path: [{ skip: 3, var: "group" }, { any: ["remove", "rm"] }],
        emit: [{ action_type: "cloud.resource.delete", params: {
          provider: c("unknown"), service: { split: { join: { var: "group" }, sep: " " }, sep: " ", index: 0 },
          kind: { map: { split: { join: { var: "group" }, sep: " " }, sep: " ", index: -1 }, table: { vol: "volume", vols: "volume", fw: "firewall" }, keep: true },
          resource_digest: { digest: ["example", { join: { var: "group" }, sep: "/" }, pos(0)] }, risk_class: destructive,
        } }],
      },
      {
        path: ["deploy"],
        emit: [{ action_type: "deploy.release", params: {
          provider: c("unknown"),
          environment: { first: [{ env_of: flag("--env", "-e") }, c("unknown")] },
          target_digest: { digest: ["example", "app", flag("--name", "-n")] },
          risk_class: { if: { in: [{ first: [{ env_of: flag("--env", "-e") }, c("unknown")] }, ["production", "unknown"]] }, then: destructive, else: sensitive },
        } }],
      },
      {
        // One write per NAME=value; the value is never read.
        path: ["secret", "set"],
        emit: [{ action_type: "secret.write", for_each: { positionals: { from: 0 } }, item_pattern: "^([A-Za-z_][A-Za-z0-9_]*)=", params: {
          store: c("example"), name_digest: { digest: ["example", { first: [flag("--env", "-e"), ""] }, { item: 1 }] }, env: { env_of: flag("--env", "-e") }, risk_class: sensitive,
        } }],
      },
      {
        path: ["db", { any: ["migrate", "rollback", "reset"], var: "verb" }],
        emit: [{ action_type: "db.migrate", params: {
          provider: c("example"), direction: { map: { var: "verb" }, table: { migrate: "up", rollback: "down", reset: "reset" } },
          env: { if: { has: ["--local"] }, then: c("development"), else: { env_of: { first: [flag("--env", "-e"), { arg_assign: "APP_ENV" }] } } },
          risk_class: { if: { any: [{ eq: [{ var: "verb" }, "migrate"] }, { has: ["--local"] }] }, then: sensitive, else: destructive },
        } }],
      },
      {
        // SQL is classified, never recorded.
        path: ["db", "exec"],
        when: { defined: flag("--command") },
        emit: [{ action_type: "db.exec", params: {
          provider: c("example"), verb: { sql: flag("--command"), field: "verb" }, risk: { sql: flag("--command"), field: "risk" },
          predicate_class: { sql: flag("--command"), field: "predicate_class" },
          scope: { if: { has: ["--local"] }, then: c("local"), else: { if: { has: ["--remote"] }, then: c("remote"), else: c("unknown") } },
        } }],
      },
      {
        // Only a call that changes something is a fetch; the host only.
        path: ["api", { var: "endpoint" }],
        when: { not: { in: [{ upper: { first: [flag("-X", "--method"), c("GET")] } }, ["GET", "HEAD"]] } },
        emit: [{ action_type: "net.fetch", params: { host: { first: [{ host_of: { var: "endpoint" } }, c("api.example.test")] }, method: { upper: { first: [flag("-X", "--method"), c("GET")] } } } }],
      },
      {
        path: ["iam", { any: ["grant", "revoke"], var: "verb" }],
        max_positionals: 1,
        emit: [{ action_type: "iam.change", params: {
          provider: c("unknown"), kind: c("role"), name_digest: { digest_list: { label: ["example", "iam"], list: { words_after: "--to" } } }, risk_class: c("identity"),
        } }],
      },
    ],
    fallback: [
      { when: { word: ["delete", "rm", "remove"] }, emit: [{ action_type: "cloud.resource.delete", params: { provider: c("unknown"), risk_class: destructive } }] },
      { when: { word: ["deploy"] }, emit: [{ action_type: "deploy.release", params: { provider: c("unknown"), environment: c("unknown"), risk_class: destructive } }] },
    ],
  },
  {
    // A tool whose options are single-dash words (`-auto-approve`, `-target=x`), that stops at any option it does not know.
    id: "exampledeploy",
    programs: ["exampledeploy"],
    via: "exampledeploy",
    launchers: false,
    single_dash_long: true,
    unknown_options: "stop",
    options: { valued: ["-target", "-var-file", "-chdir"], flags: ["-auto-approve"] },
    skip: { options: ["-help", "-version"] },
    commands: [
      {
        path: [{ any: ["apply", "destroy"], var: "verb" }],
        emit: [{ action_type: "cloud.resource.delete", when: { eq: [{ var: "verb" }, "destroy"] }, params: {
          provider: c("unknown"), service: c("exampledeploy"),
          env: { first: [{ env_of: flag("-chdir") }, { env_of: flag("-var-file") }] },
          auto_approve: { present: ["-auto-approve"], or: false }, targeted: { if: { defined: { flags: ["-target"] } }, then: c(true), else: c(false) },
          resource_digest: { digest_list: { label: ["exampledeploy"], list: { flags: ["-target"] } } }, risk_class: destructive,
        } }, { action_type: "cloud.resource.modify", when: { eq: [{ var: "verb" }, "apply"] }, params: {
          provider: c("unknown"), service: c("exampledeploy"), env: { first: [{ env_of: flag("-chdir") }, { env_of: flag("-var-file") }] },
          auto_approve: { present: ["-auto-approve"], or: false }, risk_class: { if: { defined: pos(0) }, then: destructive, else: sensitive },
          saved_plan: { if: { defined: pos(0) }, then: c(true) },
        } }],
      },
    ],
    fallback: [{ when: { word: ["destroy"] }, emit: [{ action_type: "cloud.resource.delete", params: { provider: c("unknown"), service: c("exampledeploy"), risk_class: destructive } }] }],
  },
];

const profiles = [
  {
    id: "exampletracker",
    servers: ["exampletracker", "tracker"],
    tools: [
      { names: ["create_item", "tracker_create_item"], emit: [{ action_type: "work.item.create", params: {
        provider: c("unknown"), project_digest: { digest: ["exampletracker", { server: true }, { arg: ["project", "projectKey"] }] }, risk_class: c("routine"),
      } }] },
      { names: ["update_item"], emit: [{ action_type: "work.item.update", params: { provider: c("unknown"), risk_class: c("routine") } }] },
    ],
  },
  {
    id: "examplefs",
    servers: ["examplefs"],
    via: "examplefs",
    tools: [
      { names: ["write"], when: { defined: { arg: ["path"] } }, emit: [{ action_type: "file.write", params: { path: { arg: ["path"] } } }] },
      { names: ["write_many"], emit: [{ action_type: "file.write", for_each: { arg_items: { key: "files", field: "path" } }, params: { path: { item: true } } }] },
      { names: ["read_many"], emit: [{ action_type: "file.read", for_each: { arg_list: "paths" }, params: { path: { item: true } } }] },
      { names: ["fetch_url"], emit: [{ action_type: "net.fetch", when: { defined: { host_of: { arg: ["url"] } } }, params: { host: { host_of: { arg: ["url"] } }, method: c("GET") } }] },
    ],
  },
  {
    id: "exampledb",
    servers: ["exampledb"],
    tools: [{ names: ["run_sql"], emit: [{ action_type: "db.exec", params: {
      provider: c("exampledb"), verb: { sql: { arg: ["sql", "query"] }, field: "verb" }, scope: c("unknown"),
      risk: { sql: { arg: ["sql", "query"] }, field: "risk" }, predicate_class: { sql: { arg: ["sql", "query"] }, field: "predicate_class" },
    } }] }],
  },
];

const rules = [
  { id: "example-destructive", type: "action_allowlist", mode: "monitor", action_types: ["cloud.resource.delete"], param_bounds: { risk_class: { pattern: "^(?!destructive$).+" } },
    description: "Record deleting example resources." },
  { id: "example-deploy", type: "action_allowlist", mode: "monitor", action_types: ["deploy.release"], param_bounds: { environment: { pattern: "^(?!(?:production|unknown)$).+" } } },
];

const sh = (id, command, expect, dialect) => ({ id, shell: { command, ...(dialect ? { dialect } : {}) }, expect });
const mcp = (id, server, tool, args, expect, hint) => ({ id, mcp: { server, tool, args, ...(hint ? { hint } : {}) }, expect });
const del = (params) => ({ action_type: "cloud.resource.delete", params: { ...params, via: params.via ?? "examplectl", derived_from: "shell.exec" } });
const act = (action_type, params, via = "examplectl", from = "shell.exec") => ({ action_type, params: { ...params, via, derived_from: from } });

const vectors = [
  sh("bucket-delete", "examplectl bucket delete ex://logs-prod --region eu-1 --profile prod --yes",
    [del({ provider: "unknown", service: "storage", kind: "bucket", region: "eu-1", env: "production", resource_digest: { digest_of: ["example", "storage", "logs-prod"] }, auto_approve: true, risk_class: "destructive" })]),
  sh("bucket-delete-env-prefix", "EXAMPLE_PROFILE=staging EXAMPLE_REGION=us-2 examplectl bucket rm ex://b",
    [del({ provider: "unknown", service: "storage", kind: "bucket", region: "us-2", env: "staging", resource_digest: { digest_of: ["example", "storage", "b"] }, risk_class: "destructive" })]),
  sh("bucket-delete-variable-name", "examplectl bucket delete ex://$BUCKET",
    [del({ provider: "unknown", service: "storage", kind: "bucket", risk_class: "destructive" })]),
  sh("strip-word", "examplectl beta bucket delete ex://x",
    [del({ provider: "unknown", service: "storage", kind: "bucket", resource_digest: { digest_of: ["example", "storage", "x"] }, risk_class: "destructive" })]),
  sh("launcher", "npx -y examplectl@2 bucket delete ex://x",
    [del({ provider: "unknown", service: "storage", kind: "bucket", resource_digest: { digest_of: ["example", "storage", "x"] }, risk_class: "destructive" })]),
  sh("and-chain", "cd infra && examplectl bucket delete ex://x --force && echo done",
    [del({ provider: "unknown", service: "storage", kind: "bucket", resource_digest: { digest_of: ["example", "storage", "x"] }, auto_approve: true, risk_class: "destructive" })]),
  sh("bash-c", "bash -c 'examplectl bucket delete ex://x'",
    [del({ provider: "unknown", service: "storage", kind: "bucket", resource_digest: { digest_of: ["example", "storage", "x"] }, risk_class: "destructive" })]),
  sh("help-option", "examplectl bucket delete ex://x --help", []),
  sh("help-word", "examplectl help bucket delete", []),
  sh("dry-run", "examplectl bucket delete ex://x --dry-run", []),
  sh("listing", "examplectl list buckets --weird", []),
  sh("unknown-command", "examplectl bucket show ex://x", []),
  sh("verb-kind-delete", "examplectl delete-volume vol-1",
    [del({ provider: "unknown", service: "compute", kind: "volume", resource_digest: { digest_of: ["example", "compute", "vol-1"] }, risk_class: "destructive" })]),
  sh("verb-kind-create", "examplectl create-volume",
    [act("cloud.resource.create", { provider: "unknown", service: "compute", kind: "volume", risk_class: "sensitive" })]),
  sh("skip-group", "examplectl net fw rm web",
    [del({ provider: "unknown", service: "net", kind: "firewall", resource_digest: { digest_of: ["example", "net/fw", "web"] }, risk_class: "destructive" })]),
  sh("deploy-prod", "examplectl deploy --env prod -n web",
    [act("deploy.release", { provider: "unknown", environment: "production", target_digest: { digest_of: ["example", "app", "web"] }, risk_class: "destructive" })]),
  sh("deploy-staging-attached", "examplectl deploy -estaging",
    [act("deploy.release", { provider: "unknown", environment: "staging", risk_class: "sensitive" })]),
  sh("deploy-unknown", "examplectl deploy",
    [act("deploy.release", { provider: "unknown", environment: "unknown", risk_class: "destructive" })]),
  sh("secrets", "examplectl secret set API_KEY=abc OTHER=def notapair --env dev", [
    act("secret.write", { store: "example", name_digest: { digest_of: ["example", "dev", "API_KEY"] }, env: "development", risk_class: "sensitive" }),
    act("secret.write", { store: "example", name_digest: { digest_of: ["example", "dev", "OTHER"] }, env: "development", risk_class: "sensitive" }),
  ]),
  sh("migrate-up", "examplectl db migrate APP_ENV=production",
    [act("db.migrate", { provider: "example", direction: "up", env: "production", risk_class: "sensitive" })]),
  sh("migrate-rollback-local", "examplectl db rollback --local",
    [act("db.migrate", { provider: "example", direction: "down", env: "development", risk_class: "sensitive" })]),
  sh("migrate-reset", "examplectl db reset",
    [act("db.migrate", { provider: "example", direction: "reset", risk_class: "destructive" })]),
  sh("sql-delete-all", "examplectl db exec --remote --command 'DELETE FROM users'",
    [act("db.exec", { provider: "example", verb: "delete_all", risk: "destructive", predicate_class: "all", scope: "remote" })]),
  sh("sql-bounded", "examplectl db exec --command \"UPDATE t SET a = 1 WHERE id = 3\"",
    [act("db.exec", { provider: "example", verb: "update", risk: "ordinary", predicate_class: "bounded", scope: "unknown" })]),
  sh("sql-missing", "examplectl db exec --file x.sql", []),
  sh("api-post", "examplectl api https://API.example.test/v1/items -X post",
    [act("net.fetch", { host: "api.example.test", method: "POST" })]),
  sh("api-get", "examplectl api /v1/items", []),
  sh("iam-grant", "examplectl iam grant --to bob alice",
    [act("iam.change", { provider: "unknown", kind: "role", name_digest: { digest_of: ["example", "iam", "alice", "bob"] }, risk_class: "identity" })]),
  sh("iam-too-many", "examplectl iam grant admin extra", []),
  sh("fallback-unknown-option", "examplectl --weird-option x bucket delete ex://x",
    [del({ provider: "unknown", risk_class: "destructive" })]),
  sh("fallback-deploy", "examplectl --weird deploy",
    [act("deploy.release", { provider: "unknown", environment: "unknown", risk_class: "destructive" })]),
  sh("powershell", "examplectl bucket delete ex://x --profile prod", [del({ provider: "unknown", service: "storage", kind: "bucket", env: "production", resource_digest: { digest_of: ["example", "storage", "x"] }, risk_class: "destructive" })], "powershell"),
  sh("single-dash-destroy", "exampledeploy destroy --auto-approve -target=a -target b -chdir=envs/prod", [
    act("cloud.resource.delete", { provider: "unknown", service: "exampledeploy", env: "production", auto_approve: true, targeted: true, resource_digest: { digest_of: ["exampledeploy", "a", "b"] }, risk_class: "destructive" }, "exampledeploy"),
  ]),
  sh("single-dash-apply-plan", "exampledeploy apply plan.out -var-file=dev.vars", [
    act("cloud.resource.modify", { provider: "unknown", service: "exampledeploy", env: "development", auto_approve: false, risk_class: "destructive", saved_plan: true }, "exampledeploy"),
  ]),
  sh("stop-at-unknown", "exampledeploy destroy -lock=false", [
    act("cloud.resource.delete", { provider: "unknown", service: "exampledeploy", risk_class: "destructive" }, "exampledeploy"),
  ]),
  sh("no-launcher", "npx exampledeploy destroy", []),
  mcp("tracker-create", "my-tracker", "create_item", { project: "OPS", title: "hello" },
    [act("work.item.create", { provider: "unknown", project_digest: { digest_of: ["exampletracker", "my-tracker", "OPS"] }, risk_class: "routine" }, "exampletracker", "mcp.tool.call")]),
  mcp("tracker-hint", "work", "update_item", {}, [act("work.item.update", { provider: "unknown", risk_class: "routine" }, "exampletracker", "mcp.tool.call")], "npx exampletracker-server"),
  mcp("tracker-other-tool", "exampletracker", "search", { q: "x" }, []),
  mcp("fs-write", "examplefs", "write", { path: "src/a.ts", content: "never read" }, [act("file.write", { path: "src/a.ts" }, "examplefs", "mcp.tool.call")]),
  mcp("fs-write-no-path", "examplefs", "write", { content: "x" }, []),
  mcp("fs-write-many", "examplefs", "write_many", { files: [{ path: "a" }, { path: "b" }, { other: 1 }] },
    [act("file.write", { path: "a" }, "examplefs", "mcp.tool.call"), act("file.write", { path: "b" }, "examplefs", "mcp.tool.call")]),
  mcp("fs-read-many", "examplefs", "read_many", { paths: ["x", 3, "y"] },
    [act("file.read", { path: "x" }, "examplefs", "mcp.tool.call"), act("file.read", { path: "y" }, "examplefs", "mcp.tool.call")]),
  mcp("fs-fetch", "examplefs", "fetch_url", { url: "https://Docs.Example.test/a?b=c" }, [act("net.fetch", { host: "docs.example.test", method: "GET" }, "examplefs", "mcp.tool.call")]),
  mcp("fs-fetch-not-http", "examplefs", "fetch_url", { url: "file:///etc/passwd" }, []),
  mcp("db-drop", "exampledb", "run_sql", { sql: "DROP TABLE users" },
    [act("db.exec", { provider: "exampledb", verb: "drop", scope: "unknown", risk: "destructive", predicate_class: "not_applicable" }, "exampledb", "mcp.tool.call")]),
  mcp("db-unreadable", "exampledb", "run_sql", { query: 7 },
    [act("db.exec", { provider: "exampledb", verb: "unknown", scope: "unknown", risk: "unknown" }, "exampledb", "mcp.tool.call")]),
  mcp("unknown-server", "something", "run_sql", { sql: "DROP TABLE x" }, []),
];

export function buildExamplePack() {
  const key = testPackKey();
  const unsigned = {
    format: "scopebond:pack/v1", id: "example", version: "1.0.0", issued_at: "2026-10-01T00:00:00Z",
    title: "Example pack (test vectors; made-up tools)", grammars, profiles, rules, vectors,
  };
  const placeholder = { ...unsigned, signature: { alg: "Ed25519", key_id: key.key_id, value: "A".repeat(86) + "==" } };
  const value = sign(null, Buffer.from(packSigningInput(placeholder), "utf8"), key.privateKey).toString("base64");
  return { ...unsigned, signature: { alg: "Ed25519", key_id: key.key_id, value } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pack = buildExamplePack();
  const check = validatePack(pack);
  if (!check.valid) { console.error(check.errors.join("\n")); process.exit(1); }
  const key = testPackKey();
  writeFileSync(join(here, "../vectors/example-pack.json"), `${JSON.stringify(pack, null, 2)}\n`);
  writeFileSync(join(here, "../vectors/example-pack-key.json"), `${JSON.stringify({
    description: "The TEST-ONLY public key that signs example-pack.json. Its private half is derived from a published phrase (test/build-example-pack.mjs), so it proves nothing; never trust it outside tests.",
    key_id: key.key_id, public_key: key.public_key, not_before: "2026-01-01T00:00:00Z", not_after: "2036-01-01T00:00:00Z",
  }, null, 2)}\n`);
  console.log(`wrote example-pack.json (${pack.vectors.length} vectors)`);
}
