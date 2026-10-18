// A made-up rule pack for the engine's tests of the target rules: one command-line tool (`demoinfra`) and one MCP server
// (`demorepo`) that derive every target class, and the target rules as policy clauses. Nothing here describes a real tool:
// the knowledge of real tools is delivered by Scopebond Cloud rule packs. Not signed: the tests put it in force directly
// (`setActivePacks`), as pack-store.ts does after verifying a pack.

const c = (value) => ({ const: value });
const envFlag = { env_of: { flag: ["--env", "-e"] } };
const grammar = {
  id: "demoinfra", programs: ["demoinfra"],
  options: { valued: ["--env", "-e", "--name"], flags: ["--yes", "-y"] },
  skip: { options: ["--help", "-h", "--dry-run"], words: ["help"] },
  commands: [
    { path: ["bucket", "list"], emit: [] },
    { path: ["api", "get"], emit: [] },
    { path: ["api", "post"], emit: [{ action_type: "net.fetch", params: { host: c("api.demo.example"), method: c("POST") } }] },
    { path: ["pod", "delete"], emit: [{ action_type: "k8s.delete", params: { kind: c("pod"), name_digest: { digest: ["demo", { positional: 0 }] }, risk_class: c("destructive") } }] },
    { path: ["bucket", "delete"], emit: [{ action_type: "cloud.resource.delete", params: { provider: c("unknown"), kind: c("bucket"), risk_class: c("destructive") } }] },
    { path: ["bucket", "create"], emit: [{ action_type: "cloud.resource.create", params: { provider: c("unknown"), kind: c("bucket"), risk_class: c("sensitive") } }] },
    { path: ["plan", "apply"], emit: [{ action_type: "cloud.resource.modify", params: { provider: c("unknown"), kind: c("plan"), risk_class: c("destructive") } }] },
    { path: ["pod", "exec"], emit: [{ action_type: "k8s.exec", params: { kind: c("pod"), risk_class: c("destructive") } }] },
    { path: ["deploy"], emit: [{ action_type: "deploy.release", params: { provider: c("unknown"), environment: { first: [envFlag, c("unknown")] }, risk_class: c("destructive") } }] },
    { path: ["secret", "set"], emit: [{ action_type: "secret.write", params: { store: c("demoinfra"), risk_class: c("sensitive") } }] },
    { path: ["role", "grant"], emit: [{ action_type: "iam.change", params: { provider: c("unknown"), kind: c("role"), risk_class: c("identity") } }] },
    { path: ["migrate", "up"], emit: [{ action_type: "db.migrate", params: { provider: c("unknown"), direction: c("up"), env: envFlag, risk_class: c("sensitive") } }] },
    // Down loses data, except against a development database the command names.
    { path: ["migrate", "down"], emit: [
      { action_type: "db.migrate", when: { not: { eq: [envFlag, "development"] } }, params: { provider: c("unknown"), direction: c("down"), env: envFlag, risk_class: c("destructive") } },
      { action_type: "db.migrate", when: { eq: [envFlag, "development"] }, params: { provider: c("unknown"), direction: c("down"), env: envFlag, risk_class: c("sensitive") } },
    ] },
  ],
};
// A repository server: its files are in a remote repository (`via: "github"`, the engine's label for a repository API), so a file it
// writes is recorded, not decided by this computer's file rules; the push to its branch is decided by the push rules.
const push = { action_type: "git.push", params: { repo: c("acme/web"), ref: { arg: ["branch"] }, force: c(false) } };
const profiles = [
  { id: "demorepo", servers: ["demorepo"], via: "github", tools: [
    { names: ["push_change"], emit: [push] },
    { names: ["put_file"], emit: [{ action_type: "file.write", params: { path: { arg: ["path"] }, repo: c("o/r") } }, push] },
    { names: ["push_files"], emit: [{ action_type: "file.write", for_each: { arg_items: { key: "files", field: "path" } }, params: { path: { item: true }, repo: c("o/r") } }, push] },
  ] },
  // A file server on this computer: its paths are this computer's files.
  { id: "demofs", servers: ["demofs"], tools: [
    { names: ["write_file"], emit: [{ action_type: "file.write", params: { path: { arg: ["path"] } } }] },
    { names: ["read_file"], emit: [{ action_type: "file.read", params: { path: { arg: ["path"] } } }] },
    { names: ["read_files"], emit: [{ action_type: "file.read", for_each: { arg_list: "paths" }, params: { path: { item: true } } }] },
  ] },
  { id: "demofetch", servers: ["demofetch"], tools: [
    { names: ["fetch"], emit: [{ action_type: "net.fetch", when: { defined: { host_of: { arg: ["url"] } } }, params: { host: { host_of: { arg: ["url"] } }, method: c("GET") } }] },
  ] },
  { id: "demodb", servers: ["demodb"], tools: [
    { names: ["query"], emit: [{ action_type: "db.exec", params: { provider: c("demodb"), verb: { sql: { arg: ["sql"] }, field: "verb" }, scope: c("unknown"), risk: { sql: { arg: ["sql"] }, field: "risk" }, predicate_class: { sql: { arg: ["sql"] }, field: "predicate_class" } } }] },
  ] },
];

const where = "Change this in .scopebond/rules.json (rules enforce|monitor <rule>) or in your workspace.";
export const TARGET_PACK_RULES = [
  { id: "cloud-destructive", type: "action_allowlist", mode: "monitor", action_types: ["cloud.resource.delete", "cloud.resource.modify", "k8s.delete", "k8s.exec"],
    param_bounds: { risk_class: { pattern: "^(?!destructive$).+" } }, description: `Deny deleting cloud resources and cluster objects and running commands in containers. ${where}` },
  { id: "production-deploy", type: "action_allowlist", mode: "monitor", action_types: ["deploy.release"],
    param_bounds: { environment: { pattern: "^(?!(?:production|unknown)$).+" } }, description: `Deny deployments to production, and deployments whose environment the command does not show. ${where}` },
  { id: "secret-write", type: "action_allowlist", mode: "monitor", action_types: ["secret.write"],
    param_bounds: { risk_class: { pattern: "^(?!sensitive$).+" } }, description: `Deny storing or changing secrets in a secret store. ${where}` },
  { id: "iam-change", type: "action_allowlist", mode: "monitor", action_types: ["iam.change"],
    param_bounds: { risk_class: { pattern: "^(?!identity$).+" } }, description: `Deny identity and access changes. ${where}` },
  { id: "database-migrate", type: "action_allowlist", mode: "monitor", action_types: ["db.migrate"],
    param_bounds: { risk_class: { pattern: "^(?!destructive$).+" } }, description: `Deny database migrations that go down or reset. ${where}` },
  { id: "observe-targets", type: "action_allowlist", mode: "monitor",
    action_types: ["cloud.resource.create", "cloud.resource.modify", "k8s.apply", "db.exec", "communication.send", "work.item.create", "work.item.update", "pr.open", "pr.merge"],
    description: "Observe cloud resources created or changed and other changes reached through a known tool (recorded, not blocked)." },
];

export const TARGET_PACK = {
  format: "scopebond:pack/v1", id: "demo-targets", version: "1.0.0", issued_at: "2026-10-01T00:00:00Z",
  signature: { alg: "Ed25519", key_id: "test-only", value: "A".repeat(86) + "==" },
  grammars: [grammar], profiles, rules: TARGET_PACK_RULES,
  vectors: [{ id: "delete", shell: { command: "demoinfra bucket delete logs" }, expect: [{ action_type: "cloud.resource.delete", params: { provider: "unknown", kind: "bucket", risk_class: "destructive", via: "demoinfra", derived_from: "shell.exec" } }] }],
};

/** Each command and the target classes it carries (classify.ts): what the target rules block once they are on. */
export const TARGET_VECTORS = [
  ["demoinfra bucket delete logs", ["H06"]],
  ["demoinfra pod exec api", ["H06"]],
  ["demoinfra plan apply saved.plan", ["H06"]],
  ["demoinfra deploy --env production", ["H07"]],
  ["demoinfra deploy", ["H07"]],
  ["demoinfra deploy --env staging", []],
  ["demoinfra secret set TOKEN", ["H08"]],
  ["demoinfra role grant admin", ["H09"]],
  ["demoinfra migrate down", ["H10"]],
  ["demoinfra migrate down --env development", []],
  ["demoinfra migrate up", []],
  ["demoinfra bucket create logs", []],
  ["demoinfra bucket list", []],
  ["pnpm test", []],
];
