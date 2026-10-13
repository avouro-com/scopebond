// Target profiles: what a coding agent reaches through a known command-line tool, read from the ACTUAL command line.
//
// A shell command that runs `aws`, `gcloud`, `az`, `kubectl`, `helm`, `terraform`/`tofu`, `wrangler`, `vercel`, `fly`, `gh`,
// a migration tool (prisma, drizzle-kit, rails/rake, alembic, flyway, knex, sequelize) or a deployment or secret tool (eb,
// serverless, heroku, vault, doppler, op) is described here as Action Taxonomy 1.1 actions: `cloud.resource.create|modify|
// delete`, `k8s.apply|delete|exec`, `db.migrate`, `deploy.release`, `secret.write`, `iam.change`, and `net.fetch` for
// `gh api`. One rule set then governs the same operation whichever coding tool ran it.
//
// The rules every profile keeps:
//   - Deterministic and pure: the same simple command gives the same actions, with no model, no network, no clock and no
//     file read. (Digests are keyed with this computer's digest key, as every other digest the hook records.)
//   - Bounded: only the subcommands listed in each profile are read. A command this module does not know, a dry run, a
//     help or listing command derives nothing: the command stays the plain `shell.exec` it always was. A name read after
//     an option the reader does not know is left out (the action keeps its type) rather than guessed.
//   - Uncertain is not unknown: when an option the reader does not know stops it from reading the command, but one of the
//     tool's destructive words (`delete`, `destroy`, `uninstall`, `rb`, `rm`, `exec`, `deploy`, `reset`,
//     `downgrade`, `drop`, `remove`, …) is among the command's words, the action is still derived, with every name left
//     out and a deployment's environment `unknown` (`uncertainFallback`). So an option placed before the subcommand cannot
//     move a command out of a rule's reach.
//   - No content: parameters are identifiers (provider, service, kind, region, context, namespace), closed enums and keyed
//     digests. Never a file's contents, a URL's query, a secret's value, a SQL text or a resource name in the clear: names
//     are digested (`resource_digest`, `name_digest`, `target_digest`). A value given to a secret command
//     (`gh secret set X --body …`, `fly secrets set X=…`) is never read, only the name before it.
//   - Environment from names only: `env`/`environment` is set when the command names one (an AWS profile, a GCP project, a
//     Terraform folder or var file, an `--env`, a slot or stage) and the name's words say prod, staging or dev. Otherwise it
//     is left out (or `unknown` for `deploy.release`, whose environment is required).
//
// Each action also carries `via` (the tool), `derived_from: "shell.exec"` and `risk_class`. The mapper records them as
// extra intents beside the command's `shell.exec`, in the same action group (map.ts).

import { canonProgram, type SimpleCommand } from "./shell.js";
import { digest, scrubParam } from "./minimize.js";
import { readWrangler, type FileProbe } from "./typed-infra.js";

export interface TargetOperation { action_type: string; params: Record<string, unknown> }

/** What a profile may consult beyond the command line. None of the shipped profiles reads it today; it is the seam for
 *  a caller that wants the environment a command inherits (the mapper passes nothing, so it stays pure). */
export interface TargetProbe { env?: (name: string) => string | undefined; files?: FileProbe; cwd?: string }

type Env = "production" | "staging" | "development";
type Params = Record<string, unknown>;

/** The tools this module reads, by canonical program name. */
export const TARGET_TOOLS: ReadonlySet<string> = new Set([
  "aws", "gcloud", "az", "kubectl", "helm", "terraform", "tofu", "terragrunt", "wrangler", "vercel", "fly", "flyctl", "gh",
  "prisma", "drizzle-kit", "rails", "rake", "alembic", "flyway", "knex", "sequelize", "sequelize-cli",
  "eb", "serverless", "sls", "heroku", "vault", "doppler", "op", "pulumi", "cdk", "sst",
]);

// ---- shared readers -------------------------------------------------------------------------------------------------

const SUBST = "__sb_subst";
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

/** A value fit to record as an identifier: a plain name the scrubber leaves alone, never an unexpanded variable. */
function ident(value: string | undefined): string | undefined {
  if (value === undefined || value.includes(SUBST) || !IDENT.test(value)) return undefined;
  return scrubParam(value) === value ? value : undefined;
}

/** A value fit to digest: anything the command names literally (an unexpanded variable is not a name). */
const literal = (value: string | undefined): string | undefined =>
  value !== undefined && value !== "" && !value.includes(SUBST) && !value.includes("$") ? value : undefined;

/** A keyed digest of a named resource. The parts are joined canonically, so `["a", "b/c"]` and `["a/b", "c"]` differ. */
export const targetDigest = (...parts: string[]): string => digest(["scopebond:target/v1", ...parts]);

/** The environment a name's words say: `myapp-prod`, `envs/staging`, `dev.tfvars`. Undefined when no word says one, or
 *  words say two different ones. */
export function envOfName(name: string | undefined): Env | undefined {
  if (!name || name.includes(SUBST)) return undefined;
  const found = new Set<Env>();
  for (const word of name.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word === "prod" || word === "production" || word === "prd" || word === "live") found.add("production");
    else if (word === "staging" || word === "stage" || word === "stg" || word === "preprod" || word === "uat") found.add("staging");
    else if (word === "dev" || word === "development" || word === "test" || word === "testing" || word === "qa" || word === "sandbox" || word === "local") found.add("development");
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/** A `NAME=value` the command sets for itself (`AWS_PROFILE=prod aws …`). */
function assigned(sc: SimpleCommand, name: string): string | undefined {
  for (const word of sc.assigns ?? []) if (word.startsWith(`${name}=`)) return literal(word.slice(name.length + 1));
  return undefined;
}

interface Args {
  /** Positional words, in order. */
  pos: string[];
  /** How many of `pos` were read before an option this reader does not know: later ones may be that option's value. */
  certain: number;
  flags: Map<string, string | true>;
  /** Words after `--`. */
  tail: string[];
}

/** Read an argument list: `valued` options take the next word (or `=value`), `bools` take none. Any other option is
 *  recorded as present; from it on, positionals are uncertain. */
function readArgs(argv: readonly string[], valued: ReadonlySet<string>, bools: ReadonlySet<string> = new Set()): Args {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  let certain = -1;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--") return { pos, certain: certain < 0 ? pos.length : certain, flags, tail: argv.slice(i + 1) };
    if (t.length > 1 && t.startsWith("-") && !/^-\d/.test(t)) {
      const eq = t.indexOf("=");
      if (eq > 0) { flags.set(t.slice(0, eq), t.slice(eq + 1)); continue; }
      if (valued.has(t)) { flags.set(t, argv[i + 1] ?? ""); i++; continue; }
      // An attached short value: `-nprod`.
      if (!t.startsWith("--") && t.length > 2 && valued.has(t.slice(0, 2))) { flags.set(t.slice(0, 2), t.slice(2)); continue; }
      flags.set(t, true);
      if (!bools.has(t) && certain < 0) certain = pos.length;
      continue;
    }
    pos.push(t);
  }
  return { pos, certain: certain < 0 ? pos.length : certain, flags, tail: [] };
}

const flag = (a: Args, ...names: string[]): string | undefined => {
  for (const n of names) { const v = a.flags.get(n); if (typeof v === "string" && v !== "") return v; }
  return undefined;
};
const has = (a: Args, ...names: string[]): boolean => names.some((n) => a.flags.has(n) && a.flags.get(n) !== "false");
/** The positional at `i`, only when it was read before any unknown option. */
const certainPos = (a: Args, i: number): string | undefined => (i < a.certain ? a.pos[i] : undefined);

/** The value after `--name` (or `--name=value`) anywhere in an argument list. For tools whose options all take a value
 *  unless they are switches (aws, az), so the word after a named option is its value. */
function option(argv: readonly string[], ...names: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    for (const n of names) {
      if (t === n) { const v = argv[i + 1]; if (v !== undefined && !v.startsWith("-")) return v; }
      else if (t.startsWith(`${n}=`)) return t.slice(n.length + 1);
    }
  }
  return undefined;
}
/** Every word after `--name` up to the next option (`--instance-ids i-1 i-2`). */
function optionList(argv: readonly string[], name: string): string[] {
  const at = argv.indexOf(name);
  if (at < 0) return [];
  const out: string[] = [];
  for (let i = at + 1; i < argv.length && !argv[i].startsWith("-"); i++) out.push(argv[i]);
  return out;
}
const hasWord = (argv: readonly string[], ...names: string[]): boolean => argv.some((t) => names.includes(t) || names.some((n) => t.startsWith(`${n}=`) && !/=false$/i.test(t)));

/** A keyed digest of a named resource: `label`, then the context that scopes the name (empty when not given: a project, a
 *  region, a namespace), then the name itself, last. Undefined when the command names nothing, or names it only through a
 *  variable (a value known only at run time is not a name). */
const digestOf = (label: string, ...parts: Array<string | undefined>): string | undefined => {
  const values = parts.map((p) => p ?? "");
  const name = values[values.length - 1];
  if (name === undefined || name === "" || values.some((v) => v !== "" && literal(v) === undefined)) return undefined;
  return targetDigest(label, ...values);
};

function act(action_type: string, params: Params): TargetOperation {
  const out: Params = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined) out[k] = v;
  return { action_type, params: out };
}

// ---- launchers ------------------------------------------------------------------------------------------------------

/** The tool a simple command runs and its arguments: the program itself, or a tool started through a package runner
 *  (`npx prisma`, `pnpm exec wrangler`, `uv run alembic`, `python -m alembic`, `bundle exec rails`). */
/** A package runner: the options it takes before its subcommand that take a value, its subcommands that run a tool (none:
 *  the tool comes first; `optional`: the tool may also come first, as `pnpm wrangler`), and the options of those
 *  subcommands that take a value (a package to install, a workspace to run in, a file of variables). */
interface Runner { pre: ReadonlySet<string>; subs: readonly string[]; optional?: true; post: ReadonlySet<string> }
const NODE_RUN_VALUED = new Set(["-p", "--package", "-c", "--call", "--filter", "-F", "-C", "--dir", "--workspace-dir", "--prefix", "--cwd", "-w", "--workspace",
  "--cache", "--userconfig", "--registry", "--loglevel", "--reporter", "--shell-mode"]);
const PY_RUN_VALUED = new Set(["--env-file", "--with", "--with-requirements", "--with-editable", "--project", "--package", "--python", "-p", "--group", "--extra",
  "--index", "--index-url", "--extra-index-url", "--find-links", "-f", "--directory", "-C", "-P", "--config-file", "--cache-dir", "--no-group", "--only-group", "-e", "--env"]);
const RUNNERS: Readonly<Record<string, Runner>> = {
  npx: { pre: NODE_RUN_VALUED, subs: [], post: NODE_RUN_VALUED },
  pnpx: { pre: NODE_RUN_VALUED, subs: [], post: NODE_RUN_VALUED },
  bunx: { pre: NODE_RUN_VALUED, subs: [], post: NODE_RUN_VALUED },
  pnpm: { pre: NODE_RUN_VALUED, subs: ["exec", "dlx", "x"], optional: true, post: NODE_RUN_VALUED },
  yarn: { pre: NODE_RUN_VALUED, subs: ["exec", "dlx", "x"], optional: true, post: NODE_RUN_VALUED },
  bun: { pre: NODE_RUN_VALUED, subs: ["exec", "dlx", "x"], optional: true, post: NODE_RUN_VALUED },
  npm: { pre: NODE_RUN_VALUED, subs: ["exec", "x"], post: NODE_RUN_VALUED },
  uv: { pre: PY_RUN_VALUED, subs: ["run"], post: PY_RUN_VALUED },
  poetry: { pre: PY_RUN_VALUED, subs: ["run"], post: PY_RUN_VALUED },
  pipenv: { pre: PY_RUN_VALUED, subs: ["run"], post: PY_RUN_VALUED },
  pdm: { pre: PY_RUN_VALUED, subs: ["run"], post: PY_RUN_VALUED },
  hatch: { pre: PY_RUN_VALUED, subs: ["run"], post: PY_RUN_VALUED },
  bundle: { pre: new Set(["--gemfile"]), subs: ["exec"], post: new Set(["--gemfile"]) },
};
/** The index of the first word at or after `i` that is not an option (or an option's value). */
function skipOptions(words: readonly string[], i: number, valued: ReadonlySet<string>): number {
  while (i < words.length && words[i].startsWith("-") && words[i] !== "-") {
    if (words[i] === "--") return i + 1;
    i += !words[i].includes("=") && valued.has(words[i]) ? 2 : 1;
  }
  return i;
}

export function toolOf(sc: SimpleCommand): { tool: string; argv: string[] } | null {
  if (sc.opaque) return null;
  const program = canonProgram(sc.program);
  if (TARGET_TOOLS.has(program)) return { tool: program, argv: sc.argv };
  let rest: string[];
  if (program === "python" || program === "python3" || program === "py") {
    // `python -I -m alembic`, `python -X dev -m alembic`: the module after `-m`.
    let k = 0;
    while (k < sc.argv.length && sc.argv[k] !== "-m") { if (!sc.argv[k].startsWith("-")) return null; k += sc.argv[k] === "-X" || sc.argv[k] === "-W" ? 2 : 1; }
    if (sc.argv[k] !== "-m") return null;
    rest = sc.argv.slice(k + 1);
  } else {
    const runner = RUNNERS[program];
    if (!runner) return null;
    // The runner's own options first (`pnpm --filter db exec`, `uv --directory api run`), then its subcommand, then that
    // subcommand's options (`uv run --env-file .env`, `npx -p prisma@5`); an option that takes a value takes the next word.
    let k = skipOptions(sc.argv, 0, runner.pre);
    if (runner.subs.length) {
      if (runner.subs.includes(sc.argv[k] ?? "")) k = skipOptions(sc.argv, k + 1, runner.post);
      else if (!runner.optional) return null;
    }
    rest = sc.argv.slice(k);
  }
  const word = rest[0];
  if (word === undefined) return null;
  // `prisma@5`, `wrangler@latest`, `@scope/name` is not one of these tools.
  const at = word.lastIndexOf("@");
  const tool = canonProgram(at > 0 ? word.slice(0, at) : word);
  return TARGET_TOOLS.has(tool) ? { tool, argv: rest.slice(1) } : null;
}

// ---- aws ------------------------------------------------------------------------------------------------------------

const AWS_GLOBAL_VALUED = new Set(["--region", "--profile", "--output", "--endpoint-url", "--query", "--ca-bundle", "--cli-read-timeout", "--cli-connect-timeout", "--color", "--cli-binary-format",
  "--cli-error-format"]);
const AWS_GLOBAL_BOOL = new Set(["--debug", "--no-verify-ssl", "--no-paginate", "--no-sign-request", "--no-cli-pager", "--cli-auto-prompt", "--no-cli-auto-prompt"]);
const S3_VALUED = new Set([...AWS_GLOBAL_VALUED, "--exclude", "--include", "--acl", "--sse", "--sse-c", "--sse-c-key", "--sse-kms-key-id", "--storage-class", "--grants", "--website-redirect",
  "--content-type", "--cache-control", "--content-disposition", "--content-encoding", "--content-language", "--expires", "--metadata", "--metadata-directive", "--expected-size", "--page-size",
  "--request-payer", "--source-region", "--checksum-mode", "--checksum-algorithm", "--sse-c-copy-source", "--sse-c-copy-source-key"]);
const S3_BOOL = new Set([...AWS_GLOBAL_BOOL, "--recursive", "--delete", "--dryrun", "--quiet", "--only-show-errors", "--no-progress", "--follow-symlinks", "--no-follow-symlinks", "--exact-timestamps",
  "--size-only", "--no-guess-mime-type", "--force", "--ignore-glacier-warnings", "--force-glacier-transfer", "--human-readable", "--summarize", "--bypass-governance-retention"]);
/** Options that name the resource an AWS operation acts on, most specific first. */
const AWS_RESOURCE_OPTIONS = ["--bucket", "--function-name", "--db-instance-identifier", "--db-cluster-identifier", "--stack-name", "--table-name", "--cluster", "--service", "--log-group-name",
  "--queue-url", "--topic-arn", "--repository-name", "--secret-id", "--instance-id", "--key-id", "--distribution-id", "--hosted-zone-id", "--name"];
const AWS_DELETE = /^(?:delete|terminate|deregister)-(.+)$/;
const AWS_CREATE = /^create-(.+)$/;
const AWS_MODIFY = /^(?:update|modify|put|attach|detach|enable|disable|set|stop|start|reboot|restore|replace)-(.+)$/;
const S3_BUCKET = /^s3:\/\/([^/]+)/i;
const GS_BUCKET = /^gs:\/\/([^/]+)/i;

function aws(sc: SimpleCommand, argv: string[]): TargetOperation[] {
  // The service and operation are the first two words, read before any option this reader does not know.
  const words: string[] = [];
  let i = 0;
  for (; i < argv.length && words.length < 2; i++) {
    const t = argv[i];
    if (!t.startsWith("-")) { words.push(t); continue; }
    const name = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
    if (AWS_GLOBAL_VALUED.has(name)) { if (!t.includes("=")) i++; continue; }
    if (!AWS_GLOBAL_BOOL.has(name)) return [];
  }
  if (words.length < 2) return [];
  const [service, op] = words;
  // `help` is help only in the subcommand slot (`aws iam help`, `aws iam delete-role help`), never as an option's value.
  if (service === "help" || op === "help" || argv[i] === "help" || hasWord(argv, "--dry-run", "--dryrun", "--generate-cli-skeleton")) return [];
  const region = ident(option(argv, "--region") ?? assigned(sc, "AWS_REGION") ?? assigned(sc, "AWS_DEFAULT_REGION"));
  const profile = option(argv, "--profile") ?? assigned(sc, "AWS_PROFILE");
  const env = envOfName(profile);
  const resourceName = (): string | undefined => {
    for (const name of AWS_RESOURCE_OPTIONS) { const v = option(argv, name); if (v !== undefined) return v; }
    return undefined;
  };
  const cloud = (verb: "create" | "modify" | "delete", svc: string, kind: string | undefined, resource: string | undefined, extra: Params = {}): TargetOperation =>
    act(`cloud.resource.${verb}`, { provider: "aws", service: svc, kind, region, env, resource_digest: digestOf("aws", svc, resource), ...extra });

  if (service === "s3") {
    const a = readArgs(argv.slice(i), S3_VALUED, S3_BOOL);
    const bucket = (p: string | undefined): string | undefined => (p ? S3_BUCKET.exec(p)?.[1] : undefined);
    if (op === "rm") {
      const target = certainPos(a, 0);
      if (target !== undefined && !S3_BUCKET.test(target)) return [];
      return [cloud("delete", "s3", "object", bucket(target))];
    }
    if (op === "rb") return [cloud("delete", "s3", "bucket", bucket(certainPos(a, 0)), { auto_approve: has(a, "--force") || undefined })];
    if (op === "mb") return [cloud("create", "s3", "bucket", bucket(certainPos(a, 0)))];
    if (op === "sync") {
      const destination = certainPos(a, 1);
      if (destination === undefined || !S3_BUCKET.test(destination)) return [];
      return [cloud(has(a, "--delete") ? "delete" : "modify", "s3", "object", bucket(destination))];
    }
    return [];
  }
  const svc = service === "s3api" ? "s3" : service;
  if (service === "iam") {
    if (/^(?:get|list|simulate|generate|wait)-/.test(op)) return [];
    const kind = /polic/.test(op) ? "policy"
      : /access-key|ssh-public-key|signing-certificate|service-specific-credential|login-profile|server-certificate|mfa-device/.test(op) ? "key"
      : /role|instance-profile/.test(op) ? "role"
      : /group/.test(op) ? "group"
      : /user/.test(op) ? "user" : "other";
    const name = option(argv, "--role-name", "--group-name", "--policy-arn", "--policy-name", "--user-name", "--access-key-id", "--instance-profile-name");
    return [act("iam.change", { provider: "aws", kind, name_digest: digestOf("aws", "iam", kind, name), env })];
  }
  if (service === "ssm" && op === "put-parameter") {
    return [act("secret.write", { store: "aws-ssm", name_digest: digestOf("aws-ssm", region, option(argv, "--name")), env })];
  }
  if (service === "secretsmanager" && ["create-secret", "put-secret-value", "update-secret", "restore-secret"].includes(op)) {
    return [act("secret.write", { store: "aws-secretsmanager", name_digest: digestOf("aws-secretsmanager", region, option(argv, "--secret-id", "--name")), env })];
  }
  if ((service === "cloudformation" && op === "deploy") || (service === "deploy" && op === "create-deployment")) {
    const target = service === "cloudformation" ? option(argv, "--stack-name") : option(argv, "--deployment-group-name");
    return [act("deploy.release", { provider: "aws", environment: env ?? envOfName(target) ?? "unknown", target_digest: digestOf("aws", service, target) })];
  }
  if (service === "ec2" && op.endsWith("-instances")) {
    const ids = optionList(argv, "--instance-ids").filter((id) => literal(id) !== undefined).sort();
    const resource = ids.length ? ids.join(",") : undefined;
    if (op === "terminate-instances") return [cloud("delete", "ec2", "instance", resource)];
    if (op === "run-instances") return [cloud("create", "ec2", "instance", undefined)];
    if (["stop-instances", "start-instances", "reboot-instances"].includes(op)) return [cloud("modify", "ec2", "instance", resource)];
  }
  // Deleting a message a queue delivered is how a consumer acknowledges it, not a change to a resource.
  if (service === "sqs" && (op === "delete-message" || op === "delete-message-batch")) return [];
  const del = AWS_DELETE.exec(op);
  if (del) return [cloud("delete", svc, del[1], resourceName())];
  const create = AWS_CREATE.exec(op);
  if (create) return [cloud("create", svc, create[1], resourceName())];
  const modify = AWS_MODIFY.exec(op);
  if (modify) return [cloud("modify", svc, modify[1], resourceName())];
  return [];
}

// ---- gcloud ---------------------------------------------------------------------------------------------------------

const GCLOUD_VALUED = new Set(["--project", "--account", "--configuration", "--flags-file", "--format", "--verbosity", "--impersonate-service-account", "--billing-project", "--trace-token",
  "--access-token-file", "--zone", "--region", "--location", "--member", "--role", "--condition", "--data-file", "--image", "--platform", "--service-account", "--memory", "--cpu", "--port",
  "--set-env-vars", "--update-env-vars", "--remove-env-vars", "--env-vars-file", "--set-secrets", "--update-secrets", "--source", "--tag", "--display-name", "--description",
  "--replication-policy", "--locations", "--machine-type", "--tier", "--database-version", "--labels", "--network", "--subnet", "--min-instances", "--max-instances", "--concurrency",
  "--timeout", "--ingress", "--vpc-connector", "--iam-account", "--key-file", "--runtime", "--entry-point", "--trigger-topic", "--trigger-bucket", "--version", "--boot-disk-size",
  "--boot-disk-type", "--image-family", "--image-project", "--scopes", "--metadata", "--metadata-from-file", "--instance", "--database", "--keyring", "--key", "--purpose",
  "--permissions", "--stage", "--title", "--policy-file", "--kms-key", "--cluster", "--num-nodes", "--release-channel"]);
const GCLOUD_BOOL = new Set(["--quiet", "-q", "--log-http", "--no-user-output-enabled", "--user-output-enabled", "--async", "--allow-unauthenticated", "--no-allow-unauthenticated",
  "--no-traffic", "--promote", "--no-promote", "-r", "--recursive", "--stop-previous-version", "--no-stop-previous-version", "--trigger-http", "--gen2", "--no-gen2", "--keep-disks", "--delete-disks"]);
const GCLOUD_VERBS = new Set(["create", "delete", "update", "patch", "deploy", "add", "stop", "start", "reset", "resize", "add-iam-policy-binding", "remove-iam-policy-binding", "set-iam-policy"]);

/** gcloud command groups that change this computer's CLI (its configurations, credentials, components), not a cloud resource. */
const GCLOUD_LOCAL = new Set(["config", "auth", "components", "init", "info", "topic", "help", "feedback", "survey", "version", "cheat-sheet", "docker", "emulators"]);

function gcloud(sc: SimpleCommand, argv: string[]): TargetOperation[] {
  const a = readArgs(argv, GCLOUD_VALUED, GCLOUD_BOOL);
  if (has(a, "--help", "-h")) return [];
  const path = a.pos.slice(0, a.certain);
  while (path[0] === "alpha" || path[0] === "beta" || path[0] === "preview") path.shift();
  // `help` is help in the subcommand slot (`gcloud help …`); a local group (`config configurations delete`) is no resource.
  if (path[0] === undefined || GCLOUD_LOCAL.has(path[0])) return [];
  if (path[0] === "storage" && path[1] === "rm") {
    const target = path[2];
    const bucket = target ? GS_BUCKET.exec(target)?.[1] : undefined;
    if (target !== undefined && bucket === undefined) return [];
    return [act("cloud.resource.delete", { provider: "gcp", service: "storage", kind: "object", env: envOfName(flag(a, "--project")), resource_digest: digestOf("gcp", "storage", bucket) })];
  }
  const at = path.findIndex((w, k) => k >= 1 && GCLOUD_VERBS.has(w));
  if (at < 0) return [];
  const verb = path[at];
  const group = path[0];
  const collection = at >= 2 ? path[at - 1] : group;
  // The name follows the verb, when it was read before any option this reader does not know.
  const names = path.slice(at + 1);
  const project = flag(a, "--project") ?? assigned(sc, "CLOUDSDK_CORE_PROJECT");
  const env = envOfName(project);
  const region = ident(flag(a, "--region", "--zone", "--location"));
  const name = names.length ? names.join(",") : undefined;
  const auto_approve = has(a, "--quiet", "-q") || undefined;

  if (verb === "add-iam-policy-binding" || verb === "remove-iam-policy-binding" || verb === "set-iam-policy") {
    // A binding on a project names the project itself.
    return [act("iam.change", { provider: "gcp", kind: "policy", name_digest: digestOf("gcp", group, collection, project, name), env: env ?? (group === "projects" ? envOfName(name) : undefined) })];
  }
  if (group === "iam") {
    if (!["create", "delete", "update", "patch"].includes(verb)) return [];
    const kind = path.includes("keys") ? "key" : path.includes("roles") ? "role" : path.includes("service-accounts") ? "user" : path.includes("policies") ? "policy" : "other";
    return [act("iam.change", { provider: "gcp", kind, name_digest: digestOf("gcp", "iam", kind, project, name), env })];
  }
  if (verb === "deploy") {
    if (!["run", "functions", "app"].includes(group)) return [];
    return [act("deploy.release", { provider: "gcp", environment: env ?? envOfName(name) ?? "unknown", target_digest: digestOf("gcp", group, project, region, name) })];
  }
  if (group === "secrets" && (verb === "create" || (verb === "add" && collection === "versions"))) {
    return [act("secret.write", { store: "gcp-secret-manager", name_digest: digestOf("gcp-secret-manager", project, name), env })];
  }
  if (verb === "add") return [];
  const kind = collection.replace(/s$/, "");
  const cloud = (v: "create" | "modify" | "delete"): TargetOperation =>
    act(`cloud.resource.${v}`, { provider: "gcp", service: group, kind, region, env, resource_digest: digestOf("gcp", group, collection, project, name), auto_approve: v === "delete" ? auto_approve : undefined });
  if (verb === "delete") return [cloud("delete")];
  if (verb === "create") return [cloud("create")];
  return [cloud("modify")];
}

// ---- az -------------------------------------------------------------------------------------------------------------

/** az command groups that change this computer's CLI, not a cloud resource. */
const AZ_LOCAL = new Set(["extension", "config", "account", "cache", "cloud", "bicep", "feedback", "interactive", "init", "find", "upgrade", "self-test", "version", "login", "logout"]);

function az(argv: string[]): TargetOperation[] {
  // The command path is the words before the first option; every az parameter is an option.
  const path: string[] = [];
  for (const t of argv) { if (t.startsWith("-")) break; path.push(t); }
  if (path.length < 2 || hasWord(argv, "--help", "-h")) return [];
  const name = option(argv, "--name", "-n");
  const group = option(argv, "--resource-group", "-g");
  const subscription = option(argv, "--subscription");
  const [area, second] = path;
  const env = envOfName(subscription) ?? envOfName(group) ?? (area === "group" ? envOfName(name) : undefined);
  const region = ident(option(argv, "--location", "-l"));
  const auto_approve = hasWord(argv, "--yes", "-y") || undefined;
  const last = path[path.length - 1];
  const joined = path.join(" ");

  if (area === "role" && (second === "assignment" || second === "definition") && ["create", "delete", "update"].includes(last)) {
    const assignment = [option(argv, "--role"), option(argv, "--assignee"), option(argv, "--scope"), name].filter((v) => v !== undefined).join("\n");
    return [act("iam.change", { provider: "azure", kind: "role", name_digest: digestOf("azure", joined, assignment || undefined), env })];
  }
  if (area === "ad") {
    const kind = joined === "ad sp create-for-rbac" || / credential reset$/.test(joined) ? "key"
      : second === "user" && ["create", "delete", "update"].includes(last) ? "user"
      : second === "group" && ["create", "delete", "add", "remove"].includes(last) ? "group" : undefined;
    return kind ? [act("iam.change", { provider: "azure", kind, name_digest: digestOf("azure", joined, name ?? option(argv, "--id")), env })] : [];
  }
  if (joined === "keyvault secret set") {
    return [act("secret.write", { store: "azure-keyvault", name_digest: digestOf("azure-keyvault", option(argv, "--vault-name"), name), env })];
  }
  if (joined === "webapp deploy" || joined === "webapp up" || /^(?:webapp|functionapp) deployment source config-zip$/.test(joined)) {
    // An app service without a slot is its production slot.
    const slot = option(argv, "--slot", "-s");
    return [act("deploy.release", { provider: "azure", environment: slot === undefined ? "production" : envOfName(slot) ?? "unknown", target_digest: digestOf("azure", area, group, slot, name) })];
  }
  if (AZ_LOCAL.has(area)) return [];
  const service = area === "group" ? "resource" : area;
  const kind = joined === "group delete" || joined === "group create" ? "resource-group" : path.length >= 3 ? path[path.length - 2] : area;
  const cloud = (v: "create" | "modify" | "delete"): TargetOperation =>
    act(`cloud.resource.${v}`, { provider: "azure", service, kind, region, env, resource_digest: digestOf("azure", joined, subscription, group, name), auto_approve: v === "delete" ? auto_approve : undefined });
  // `delete`, and its batch and purge forms (`storage blob delete-batch`, `keyvault purge`).
  if (last === "delete" || last === "delete-batch" || last === "purge") return [cloud("delete")];
  if (last === "create") return [cloud("create")];
  if (["update", "stop", "start", "restart", "deallocate", "resize"].includes(last)) return [cloud("modify")];
  return [];
}

// ---- kubectl and helm ---------------------------------------------------------------------------------------------------

const KUBECTL_VALUED = new Set(["--context", "-n", "--namespace", "--kubeconfig", "--cluster", "--user", "-s", "--server", "--token", "--as", "--as-group", "--as-uid", "--request-timeout",
  "--certificate-authority", "--client-certificate", "--client-key", "--tls-server-name", "--cache-dir", "-v", "--v", "-f", "--filename", "-k", "--kustomize", "-l", "--selector", "-o", "--output",
  "-c", "--container", "--field-selector", "--grace-period", "--timeout", "--cascade", "--field-manager", "-p", "--patch", "--type", "--replicas", "--image", "--from-literal", "--from-file",
  "--pod-running-timeout", "--raw", "--prune-allowlist", "--subresource", "--template"]);
const KUBECTL_BOOL = new Set(["--all", "-A", "--all-namespaces", "--force", "--now", "--wait", "-i", "--stdin", "-t", "--tty", "-it", "-ti", "--prune", "--overwrite", "--record", "-R",
  "--recursive", "--ignore-not-found", "--server-side", "--force-conflicts", "--quiet", "-q", "--insecure-skip-tls-verify", "--local", "--dry-run", "--validate", "--include-uninitialized"]);
const KUBE_KINDS: Readonly<Record<string, string>> = {
  po: "pod", pods: "pod", svc: "service", services: "service", deploy: "deployment", deployments: "deployment", ns: "namespace", namespaces: "namespace", cm: "configmap",
  configmaps: "configmap", sts: "statefulset", statefulsets: "statefulset", ds: "daemonset", daemonsets: "daemonset", rs: "replicaset", replicasets: "replicaset", pvc: "persistentvolumeclaim",
  pv: "persistentvolume", ing: "ingress", ingresses: "ingress", sa: "serviceaccount", serviceaccounts: "serviceaccount", no: "node", nodes: "node", secrets: "secret", jobs: "job",
  cj: "cronjob", cronjobs: "cronjob", crd: "customresourcedefinition", crds: "customresourcedefinition",
};
const kubeKind = (word: string | undefined): string | undefined => {
  const base = ident(word?.toLowerCase().split(".")[0]);
  return base === undefined ? undefined : KUBE_KINDS[base] ?? base;
};
const K8S_APPLY = new Set(["apply", "create", "replace", "patch", "scale", "set", "label", "annotate", "autoscale", "expose", "edit", "drain", "cordon", "uncordon", "taint"]);

function kubectl(argv: string[]): TargetOperation[] {
  const a = readArgs(argv, KUBECTL_VALUED, KUBECTL_BOOL);
  const verb = certainPos(a, 0);
  if (verb === undefined || has(a, "--help", "-h")) return [];
  const dryRun = a.flags.get("--dry-run");
  if (dryRun !== undefined && dryRun !== "none") return [];
  const context = ident(flag(a, "--context"));
  const namespace = ident(flag(a, "-n", "--namespace"));
  // `kind name…`, `kind/name`, or `kind1,kind2 name`: names only when read before an unknown option.
  const target = (from: number): { kind?: string; names: string[] } => {
    const first = certainPos(a, from);
    if (first === undefined) return { names: [] };
    if (first.includes("/")) {
      const parts = a.pos.slice(from, a.certain);
      return { kind: kubeKind(first.slice(0, first.indexOf("/"))), names: parts.map((p) => p.slice(p.indexOf("/") + 1)) };
    }
    return { kind: first.includes(",") ? undefined : kubeKind(first), names: a.pos.slice(from + 1, a.certain) };
  };
  const nameDigest = (kind: string | undefined, names: string[]): string | undefined =>
    names.length ? digestOf("k8s", context ?? "", namespace ?? "", kind ?? "", ...names) : undefined;
  if (verb === "rollout") {
    if (!["restart", "undo", "pause", "resume"].includes(a.pos[1] ?? "")) return [];
    const t = target(2);
    return [act("k8s.apply", { context, namespace, kind: t.kind, name_digest: nameDigest(t.kind, t.names) })];
  }
  if (K8S_APPLY.has(verb)) {
    const fromFile = has(a, "-f", "--filename", "-k", "--kustomize");
    const t = fromFile && verb !== "scale" && verb !== "label" && verb !== "annotate" ? { names: [] as string[] } : target(verb === "set" ? 2 : 1);
    return [act("k8s.apply", { context, namespace, kind: t.kind, name_digest: nameDigest(t.kind, t.names) })];
  }
  if (verb === "delete") {
    const fromFile = has(a, "-f", "--filename", "-k", "--kustomize");
    const t = fromFile ? { names: [] as string[] } : target(1);
    const all = has(a, "--all", "-A", "--all-namespaces") || undefined;
    return [act("k8s.delete", { context, namespace, kind: t.kind, name_digest: nameDigest(t.kind, t.names), all })];
  }
  if (verb === "exec" || verb === "attach" || verb === "debug") {
    const first = certainPos(a, 1);
    const slash = first?.indexOf("/") ?? -1;
    const kind = first === undefined ? undefined : slash > 0 ? kubeKind(first.slice(0, slash)) : verb === "debug" ? undefined : "pod";
    const name = first === undefined ? undefined : slash > 0 ? first.slice(slash + 1) : first;
    return [act("k8s.exec", { context, namespace, kind, name_digest: name ? nameDigest(kind, [name]) : undefined })];
  }
  return [];
}

const HELM_VALUED = new Set(["-n", "--namespace", "--kube-context", "--kubeconfig", "-f", "--values", "--set", "--set-string", "--set-file", "--set-json", "--set-literal", "--version", "--repo",
  "--timeout", "-o", "--output", "--post-renderer", "--post-renderer-args", "--description", "--registry-config", "--repository-config", "--repository-cache", "--kube-token",
  "--kube-apiserver", "--kube-as-user", "--kube-as-group", "--kube-ca-file", "--kube-tls-server-name", "--burst-limit", "--qps", "--history-max", "--cascade", "--username", "--password",
  "--ca-file", "--cert-file", "--key-file", "--name-template", "--labels"]);
const HELM_BOOL = new Set(["--install", "-i", "--wait", "--wait-for-jobs", "--atomic", "--debug", "--create-namespace", "--force", "--reuse-values", "--reset-values", "--reset-then-reuse-values",
  "--dependency-update", "--devel", "--skip-crds", "--no-hooks", "--keep-history", "--insecure-skip-tls-verify", "--generate-name", "-g", "--replace", "--cleanup-on-fail",
  "--render-subchart-notes", "--disable-openapi-validation", "--take-ownership", "--rollback-on-failure", "--plain-http", "--pass-credentials", "--verify", "--skip-schema-validation",
  "--hide-notes", "--enable-dns", "--recreate-pods"]);

function helm(argv: string[]): TargetOperation[] {
  const a = readArgs(argv, HELM_VALUED, HELM_BOOL);
  const verb = certainPos(a, 0);
  if (verb === undefined || a.flags.has("--dry-run") || has(a, "--help", "-h")) return [];
  const context = ident(flag(a, "--kube-context"));
  const namespace = ident(flag(a, "-n", "--namespace"));
  const releases = (from: number, count: number): string[] => a.pos.slice(from, Math.min(a.certain, from + count));
  const nameDigest = (names: string[]): string | undefined => (names.length ? digestOf("k8s", context ?? "", namespace ?? "", "helm-release", ...names) : undefined);
  if (verb === "install" || verb === "upgrade" || verb === "rollback") {
    const names = verb === "install" && has(a, "--generate-name", "-g") ? [] : releases(1, 1);
    return [act("k8s.apply", { context, namespace, kind: "helm-release", name_digest: nameDigest(names) })];
  }
  if (["uninstall", "delete", "del", "un"].includes(verb)) {
    return [act("k8s.delete", { context, namespace, kind: "helm-release", name_digest: nameDigest(releases(1, a.certain)) })];
  }
  return [];
}

// ---- terraform and OpenTofu ---------------------------------------------------------------------------------------------

const TF_VALUED = new Set(["-target", "-var", "-var-file", "-replace", "-parallelism", "-state", "-state-out", "-backup", "-lock-timeout", "-exclude"]);

function terraform(sc: SimpleCommand, tool: string, argv: string[]): TargetOperation[] {
  let chdir: string | undefined;
  let i = 0;
  for (; i < argv.length && argv[i].startsWith("-"); i++) {
    if (argv[i].startsWith("-chdir=")) chdir = argv[i].slice(7);
    else if (argv[i] === "-help" || argv[i] === "-version" || argv[i] === "--help" || argv[i] === "--version") return [];
  }
  const sub = argv[i];
  if (sub !== "apply" && sub !== "destroy") return [];
  const rest = argv.slice(i + 1);
  const targets: string[] = [];
  const varFiles: string[] = [];
  let autoApprove = false;
  let destroy = sub === "destroy";
  let refreshOnly = false;
  const positional: string[] = [];
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k].replace(/^--/, "-");
    const eq = t.indexOf("=");
    const name = eq > 0 ? t.slice(0, eq) : t;
    if (!t.startsWith("-")) { positional.push(t); continue; }
    const value = eq > 0 ? t.slice(eq + 1) : TF_VALUED.has(name) ? rest[++k] : undefined;
    const on = eq < 0 || !/^false$/i.test(t.slice(eq + 1));
    if (name === "-auto-approve") autoApprove = on;
    else if (name === "-destroy") destroy = destroy || on;
    else if (name === "-refresh-only") refreshOnly = on;
    else if (name === "-target" && value !== undefined) targets.push(value);
    else if (name === "-var-file" && value !== undefined) varFiles.push(value);
    else if (name === "-help") return [];
  }
  if (refreshOnly) return [];
  // A saved plan applies without asking, and the command does not show what it changes: it may destroy as well
  // (`saved_plan`, risk class destructive).
  const planFile = sub === "apply" && positional.length > 0;
  const env = envOfName(chdir) ?? varFiles.map((f) => envOfName(f)).find((e) => e !== undefined) ?? envOfName(assigned(sc, "TF_WORKSPACE"));
  const named = targets.filter((t) => literal(t) !== undefined).sort();
  return [act(destroy ? "cloud.resource.delete" : "cloud.resource.modify", {
    provider: "unknown", service: "terraform", env, auto_approve: autoApprove || planFile, targeted: targets.length > 0,
    resource_digest: named.length ? targetDigest(tool, ...named) : undefined, saved_plan: planFile && !destroy ? true : undefined,
  })];
}

const TG_VALUED = new Set(["--terragrunt-working-dir", "--working-dir", "--terragrunt-config", "--config", "--terragrunt-iam-role", "--iam-assume-role",
  "--terragrunt-tfpath", "--tf-path", "--terragrunt-parallelism", "--parallelism", "--terragrunt-log-level", "--log-level"]);

/** Terragrunt runs Terraform: `run-all apply` (or `run --all apply`, `apply-all`) is an apply, `destroy-all` a destroy.
 *  Its working folder is read like Terraform's `-chdir`. */
function terragrunt(sc: SimpleCommand, argv: string[]): TargetOperation[] {
  const words: string[] = [];
  let chdir: string | undefined;
  for (let k = 0; k < argv.length; k++) {
    const t = argv[k];
    const eq = t.indexOf("=");
    const name = eq > 0 ? t.slice(0, eq) : t;
    if (TG_VALUED.has(name)) {
      const value = eq > 0 ? t.slice(eq + 1) : argv[++k];
      if (name === "--terragrunt-working-dir" || name === "--working-dir") chdir = value;
      continue;
    }
    if (/^--(?:terragrunt-|tg-)/.test(t) || t === "--all" || t === "--non-interactive") continue;
    words.push(t);
  }
  const sub = words.findIndex((w) => !w.startsWith("-"));
  if (sub < 0) return [];
  if (words[sub] === "run-all" || words[sub] === "run") words.splice(sub, 1);
  else if (words[sub] === "apply-all") words[sub] = "apply";
  else if (words[sub] === "destroy-all") words[sub] = "destroy";
  return terraform(sc, "terragrunt", chdir !== undefined ? [`-chdir=${chdir}`, ...words] : words);
}

// ---- wrangler -----------------------------------------------------------------------------------------------------------

function wrangler(sc: SimpleCommand): TargetOperation[] {
  const w = readWrangler(sc);
  if (!w) return [];
  const { pos, s } = w;
  if (s.flags.has("--dry-run") || s.flags.has("--help") || s.flags.has("-h")) return [];
  const value = (n: string, ...more: string[]): string | undefined => {
    for (const k of [n, ...more]) { const v = s.flags.get(k); if (typeof v === "string" && v !== "") return v; }
    return undefined;
  };
  const envName = value("--env", "-e");
  const env = envOfName(envName);
  const [area, sub] = pos;
  const auto_approve = s.flags.has("--yes") || s.flags.has("-y") || s.flags.has("--skip-confirmation") || s.flags.has("--force") || undefined;
  const cf = (verb: "create" | "delete", service: string, kind: string, name: string | undefined): TargetOperation =>
    act(`cloud.resource.${verb}`, { provider: "cloudflare", service, kind, env, resource_digest: digestOf("cloudflare", service, kind, name), auto_approve: verb === "delete" ? auto_approve : undefined });
  if (area === "deploy" || area === "publish" || (area === "versions" && sub === "deploy")) {
    return [act("deploy.release", { provider: "cloudflare", environment: env ?? "unknown", target_digest: digestOf("cloudflare", "worker", envName, value("--name")) })];
  }
  if (area === "pages" && sub === "deploy") {
    const branch = value("--branch");
    const environment = branch === undefined ? "unknown" : /^(?:main|master|production)$/.test(branch) ? "production" : "preview";
    return [act("deploy.release", { provider: "cloudflare", environment, target_digest: digestOf("cloudflare", "pages", value("--project-name")) })];
  }
  if (area === "secret" && sub === "put") return [act("secret.write", { store: "wrangler", name_digest: digestOf("wrangler", value("--name"), envName, pos[2]), env })];
  if (area === "secret" && sub === "bulk") return [act("secret.write", { store: "wrangler", env })];
  if (area === "secret" && sub === "delete") return [act("secret.write", { store: "wrangler", name_digest: digestOf("wrangler", value("--name"), envName, pos[2]), env, delete: true })];
  if (area === "delete" && pos.length <= 2) return [cf("delete", "workers", "worker", value("--name") ?? pos[1])];
  if (area === "d1" && sub === "migrations" && pos[2] === "apply") {
    const local = s.flags.has("--local");
    return [act("db.migrate", { provider: "cloudflare_d1", direction: "up", env: local ? "development" : env })];
  }
  if (area === "d1" && (sub === "create" || sub === "delete") && pos[2]) return [cf(sub, "d1", "database", pos[2])];
  if (area === "r2" && sub === "bucket" && (pos[2] === "create" || pos[2] === "delete") && pos[3]) return [cf(pos[2], "r2", "bucket", pos[3])];
  if (area === "r2" && sub === "object" && pos[2] === "delete" && pos[3]) return [cf("delete", "r2", "object", pos[3].slice(0, pos[3].indexOf("/") > 0 ? pos[3].indexOf("/") : undefined))];
  if (area === "kv" && sub === "namespace" && (pos[2] === "create" || pos[2] === "delete")) return [cf(pos[2], "kv", "namespace", pos[3] ?? value("--namespace-id", "--binding"))];
  if (area === "pages" && sub === "project" && (pos[2] === "create" || pos[2] === "delete") && pos[3]) return [cf(pos[2], "pages", "project", pos[3])];
  if (area === "queues" && (sub === "create" || sub === "delete") && pos[2]) return [cf(sub, "queues", "queue", pos[2])];
  return [];
}

// ---- vercel ---------------------------------------------------------------------------------------------------------------

const VERCEL_VALUED = new Set(["--token", "-t", "--scope", "-S", "--cwd", "--local-config", "-A", "--global-config", "-Q", "--team", "-T", "--target", "--env", "-e", "--build-env", "-b",
  "--meta", "-m", "--regions", "--archive", "--name"]);
const VERCEL_BOOL = new Set(["--prod", "--yes", "-y", "--debug", "-d", "--force", "-f", "--prebuilt", "--public", "-p", "--no-wait", "--with-cache", "--skip-domain", "--no-color", "--logs", "-l", "--no-clipboard"]);
const VERCEL_COMMANDS = new Set(["deploy", "dev", "build", "env", "promote", "rollback", "remove", "rm", "project", "projects", "ls", "list", "inspect", "logs", "link", "pull", "login", "logout",
  "whoami", "domains", "dns", "certs", "alias", "aliases", "secrets", "teams", "switch", "help", "init", "git", "bisect", "redeploy", "integration", "telemetry", "target", "targets", "blob",
  "cache", "microfrontends", "install", "open", "mcp", "api", "curl", "upgrade", "i", "integrations"]);

function vercel(argv: string[]): TargetOperation[] {
  const a = readArgs(argv, VERCEL_VALUED, VERCEL_BOOL);
  if (has(a, "--help", "-h", "--version", "-v")) return [];
  const first = certainPos(a, 0);
  const target = flag(a, "--target");
  // An option this reader does not know might choose the environment: then it is not known to be a preview.
  const unknownOption = [...a.flags.keys()].some((f) => !VERCEL_VALUED.has(f) && !VERCEL_BOOL.has(f));
  const environment = has(a, "--prod") || target === "production" ? "production" : target !== undefined ? envOfName(target) ?? "preview" : unknownOption ? "unknown" : "preview";
  const deploy = (env: string): TargetOperation[] => [act("deploy.release", { provider: "vercel", environment: env, target_digest: digestOf("vercel", flag(a, "--scope", "-S", "--team", "-T")) })];
  if (first === undefined) return a.certain === a.pos.length ? deploy(environment) : [];
  if (first === "deploy" || first === "redeploy" || !VERCEL_COMMANDS.has(first)) return deploy(environment);
  if (first === "promote" || first === "rollback") return deploy("production");
  if (first === "env" && certainPos(a, 1) === "add") {
    const name = certainPos(a, 2);
    const env = certainPos(a, 3);
    return [act("secret.write", { store: "vercel", name_digest: digestOf("vercel", name), env: envOfName(env) })];
  }
  if (first === "env" && (certainPos(a, 1) === "rm" || certainPos(a, 1) === "remove")) {
    return [act("secret.write", { store: "vercel", name_digest: digestOf("vercel", certainPos(a, 2)), env: envOfName(certainPos(a, 3)), delete: true })];
  }
  if (first === "remove" || first === "rm") {
    const names = a.pos.slice(1, a.certain).filter((n) => literal(n) !== undefined).sort();
    return [act("cloud.resource.delete", { provider: "vercel", service: "deployments", kind: "deployment", resource_digest: names.length ? targetDigest("vercel", ...names) : undefined, auto_approve: has(a, "--yes", "-y") || undefined })];
  }
  if ((first === "project" || first === "projects") && (certainPos(a, 1) === "rm" || certainPos(a, 1) === "remove")) {
    return [act("cloud.resource.delete", { provider: "vercel", service: "projects", kind: "project", resource_digest: digestOf("vercel", "project", certainPos(a, 2)) })];
  }
  return [];
}

// ---- fly ------------------------------------------------------------------------------------------------------------------

const FLY_VALUED = new Set(["-a", "--app", "-c", "--config", "-t", "--access-token", "-r", "--region", "--image", "--image-label", "--strategy", "--build-arg", "-e", "--env", "--dockerfile",
  "--org", "-o", "--build-target", "--wait-timeout", "--release-command-timeout", "--vm-size", "--vm-memory", "--vm-cpus", "--primary-region", "--label", "--file-literal", "--file-local",
  "--file-secret", "--build-secret", "--build-secret-file"]);
const FLY_BOOL = new Set(["--remote-only", "--local-only", "--detach", "--yes", "-y", "--now", "--stage", "--debug", "--verbose", "--json", "-j", "--no-cache", "--ha", "--auto-confirm",
  "--force", "-f", "--build-only", "--update-only", "--no-public-ips", "--smoke-checks"]);
const SECRET_NAME = /^([A-Za-z_][A-Za-z0-9_]*)=/;

function fly(argv: string[]): TargetOperation[] {
  const a = readArgs(argv, FLY_VALUED, FLY_BOOL);
  if (has(a, "--help", "-h")) return [];
  const app = flag(a, "-a", "--app");
  const [first, second] = [certainPos(a, 0), certainPos(a, 1)];
  const env = envOfName(app);
  const auto_approve = has(a, "--yes", "-y", "--force", "-f", "--auto-confirm") || undefined;
  if (first === "deploy") return [act("deploy.release", { provider: "fly", environment: env ?? "unknown", target_digest: digestOf("fly", app) })];
  if (first === "secrets" && second === "set") {
    // One write per NAME=value; the value after the `=` is never read.
    const names = a.pos.slice(2).map((w) => SECRET_NAME.exec(w)?.[1]).filter((n): n is string => n !== undefined);
    return names.map((n) => act("secret.write", { store: "fly", name_digest: digestOf("fly", app, n), env }));
  }
  if (first === "secrets" && second === "import") return [act("secret.write", { store: "fly", env })];
  const destroy = (kind: string, name: string | undefined): TargetOperation[] =>
    [act("cloud.resource.delete", { provider: "fly", service: kind === "app" ? "apps" : `${kind}s`, kind, env, resource_digest: digestOf("fly", kind, name ?? app), auto_approve })];
  if (first === "destroy") return destroy("app", certainPos(a, 1));
  if (first === "apps" && (second === "destroy" || second === "delete")) return destroy("app", certainPos(a, 2));
  if ((first === "machine" || first === "machines" || first === "m") && ["destroy", "remove", "rm"].includes(second ?? "")) return destroy("machine", certainPos(a, 2));
  if ((first === "volumes" || first === "volume" || first === "vol") && ["destroy", "delete", "rm"].includes(second ?? "")) return destroy("volume", certainPos(a, 2));
  return [];
}

// ---- gh -------------------------------------------------------------------------------------------------------------------

const GH_SECRET_VALUED = new Set(["-R", "--repo", "-b", "--body", "-e", "--env", "-o", "--org", "-a", "--app", "-f", "--env-file", "-v", "--visibility", "-r", "--repos"]);
const GH_API_VALUED = new Set(["-X", "--method", "-H", "--header", "-F", "--field", "-f", "--raw-field", "--input", "-q", "--jq", "-t", "--template", "--cache", "-p", "--preview", "--hostname"]);
const GH_API_BOOL = new Set(["--paginate", "--slurp", "-i", "--include", "--silent", "--verbose"]);
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

function gh(argv: string[]): TargetOperation[] {
  const [area, action] = argv;
  if (area === "secret" && action === "set") {
    const a = readArgs(argv.slice(2), GH_SECRET_VALUED, new Set(["--no-store", "--user", "-u", "--app"]));
    const scope = flag(a, "-o", "--org") ?? flag(a, "-R", "--repo") ?? "";
    const envName = flag(a, "-e", "--env");
    const name = certainPos(a, 0);
    return [act("secret.write", { store: "github", name_digest: name === undefined ? undefined : digestOf("github", scope, envName ?? "", name), env: envOfName(envName) })];
  }
  if (area === "repo" && action === "delete") {
    const a = readArgs(argv.slice(2), new Set(), new Set(["--yes", "--confirm", "-y"]));
    return [act("cloud.resource.delete", { provider: "github", service: "repo", kind: "repo", resource_digest: digestOf("github", "repo", certainPos(a, 0) ?? ""), auto_approve: has(a, "--yes", "--confirm", "-y") || undefined })];
  }
  if (area === "api") {
    const a = readArgs(argv.slice(1), GH_API_VALUED, GH_API_BOOL);
    const endpoint = certainPos(a, 0);
    if (endpoint === undefined) return [];
    let host = (flag(a, "--hostname") ?? "github.com").toLowerCase();
    if (/^https?:\/\//i.test(endpoint)) { try { host = new URL(endpoint).hostname.toLowerCase(); } catch { return []; } }
    else host = host === "github.com" ? "api.github.com" : host;
    if (ident(host) === undefined) return [];
    const fields = has(a, "-F", "--field", "-f", "--raw-field", "--input");
    const method = (flag(a, "-X", "--method") ?? (endpoint === "graphql" || fields ? "POST" : "GET")).toUpperCase();
    // A read is what `gh` is for, and a site rule's list names `github.com`, not `api.github.com` (an allowed site
    // covers its subdomains only when written `*.github.com`): only a call that changes something is a `net.fetch`.
    if (method === "GET" || method === "HEAD") return [];
    return HTTP_METHODS.has(method) ? [act("net.fetch", { host, method })] : [];
  }
  return [];
}

// ---- database migrations ----------------------------------------------------------------------------------------------------

type Direction = "up" | "down" | "reset";

function migrations(sc: SimpleCommand, tool: string, argv: string[]): TargetOperation[] {
  const migrate = (provider: string, direction: Direction, env: Env | undefined): TargetOperation => act("db.migrate", { provider, direction, env });
  const envFlag = (): string | undefined => option(argv, "--env", "-e", "--environment");
  if (tool === "prisma") {
    const [area, verb] = argv;
    if (area === "migrate") {
      if (verb === "deploy") return [migrate("prisma", "up", envOfName(envFlag()))];
      if (verb === "dev") return [migrate("prisma", "up", "development")];
      if (verb === "reset") return [migrate("prisma", "reset", undefined)];
      return [];
    }
    if (area === "db" && verb === "push") {
      const direction: Direction = argv.includes("--force-reset") ? "reset" : argv.includes("--accept-data-loss") ? "down" : "up";
      return [migrate("prisma", direction, undefined)];
    }
    return [];
  }
  if (tool === "drizzle-kit") return argv[0] === "push" || argv[0] === "migrate" ? [migrate("drizzle", "up", undefined)] : argv[0] === "drop" ? [migrate("drizzle", "down", undefined)] : [];
  if (tool === "rails" || tool === "rake") {
    // `RAILS_ENV=production rails db:migrate`, `rails db:migrate RAILS_ENV=production`, `rails -e production …`.
    const envWord = argv.find((w) => w.startsWith("RAILS_ENV="))?.slice(10) ?? assigned(sc, "RAILS_ENV") ?? option(argv, "-e", "--environment");
    const env = envOfName(envWord);
    // `db:migrate VERSION=…` migrates to that version, down as well as up (`VERSION=0` undoes every migration).
    const toVersion = argv.some((w) => w.startsWith("VERSION=")) || assigned(sc, "VERSION") !== undefined;
    const out: TargetOperation[] = [];
    for (const task of argv) {
      if (task === "db:migrate" && toVersion) out.push(migrate("rails", "down", env));
      else if (task === "db:migrate" || task === "db:migrate:up" || task === "db:prepare" || task === "db:setup" || task === "db:schema:load") out.push(migrate("rails", task === "db:schema:load" || task === "db:setup" ? "reset" : "up", env));
      else if (task === "db:rollback" || task === "db:migrate:down" || task === "db:migrate:redo") out.push(migrate("rails", "down", env));
      else if (task === "db:reset" || task === "db:drop" || task === "db:purge" || task === "db:migrate:reset") out.push(migrate("rails", "reset", env));
    }
    return out;
  }
  if (tool === "alembic") {
    const a = readArgs(argv, new Set(["-c", "--config", "-n", "--name", "-x"]), new Set(["--raiseerr", "--sql", "-q", "--quiet"]));
    if (has(a, "--sql")) return [];
    const verb = certainPos(a, 0);
    return verb === "upgrade" ? [migrate("alembic", "up", undefined)] : verb === "downgrade" ? [migrate("alembic", "down", undefined)] : [];
  }
  if (tool === "flyway") {
    const verb = argv.find((w) => !w.startsWith("-"));
    const env = envOfName(option(argv, "-environment"));
    return verb === "migrate" ? [migrate("flyway", "up", env)] : verb === "undo" ? [migrate("flyway", "down", env)] : verb === "clean" ? [migrate("flyway", "reset", env)] : [];
  }
  if (tool === "knex") {
    const verb = argv.find((w) => !w.startsWith("-"));
    const env = envOfName(envFlag());
    return verb === "migrate:latest" || verb === "migrate:up" ? [migrate("knex", "up", env)] : verb === "migrate:rollback" || verb === "migrate:down" ? [migrate("knex", "down", env)] : [];
  }
  if (tool === "sequelize" || tool === "sequelize-cli") {
    const verb = argv.find((w) => !w.startsWith("-"));
    const env = envOfName(envFlag());
    if (verb === "db:migrate") return [migrate("sequelize", "up", env)];
    if (verb === "db:migrate:undo" || verb === "db:migrate:undo:all") return [migrate("sequelize", "down", env)];
    if (verb === "db:drop") return [migrate("sequelize", "reset", env)];
    return [];
  }
  return [];
}

// ---- other deployment and secret tools --------------------------------------------------------------------------------------

const VAULT_NOT_A_SECRET = /^(?:auth\/.+\/login(?:\/|$)|[^/]+\/(?:encrypt|decrypt|rewrap|sign|sign-verbatim|verify|hmac|hash|random|datakey|issue|sign-intermediate|sign-self-issued|tidy)(?:\/|$))/;

function others(sc: SimpleCommand, tool: string, argv: string[]): TargetOperation[] {
  if (tool === "eb") {
    const a = readArgs(argv, new Set(["--profile", "--region", "-r", "-l", "--label", "-m", "--message", "--timeout", "--source", "--version", "--env-group-suffix"]),
      new Set(["--staged", "--process", "-p", "--nohang", "--force", "--all", "--ignore-links", "--debug", "--quiet", "--verbose", "-v"]));
    const verb = certainPos(a, 0);
    const envName = certainPos(a, 1);
    const env = envOfName(flag(a, "--profile")) ?? envOfName(envName);
    if (verb === "deploy") return [act("deploy.release", { provider: "aws", environment: env ?? "unknown", target_digest: digestOf("aws", "elasticbeanstalk", envName) })];
    if (verb === "terminate") return [act("cloud.resource.delete", { provider: "aws", service: "elasticbeanstalk", kind: "environment", region: ident(flag(a, "--region", "-r")), env, resource_digest: digestOf("aws", "elasticbeanstalk", envName), auto_approve: has(a, "--force") || undefined })];
    return [];
  }
  if (tool === "serverless" || tool === "sls") {
    const a = readArgs(argv, new Set(["-s", "--stage", "-r", "--region", "--aws-profile", "-c", "--config", "-f", "--function", "--param", "--org", "--app"]), new Set(["--verbose", "--force", "--debug"]));
    const verb = certainPos(a, 0);
    const stage = flag(a, "-s", "--stage");
    const env = envOfName(stage) ?? envOfName(flag(a, "--aws-profile"));
    // Without `--stage`, Serverless deploys to its default stage, `dev`.
    const deployEnv = env ?? (stage === undefined ? "development" : "unknown");
    if (verb === "deploy") return [act("deploy.release", { provider: "unknown", environment: deployEnv, target_digest: digestOf("serverless", flag(a, "-c", "--config") ?? "", stage ?? "") })];
    if (verb === "remove") return [act("cloud.resource.delete", { provider: "unknown", service: "serverless", kind: "service", region: ident(flag(a, "-r", "--region")), env, resource_digest: digestOf("serverless", flag(a, "-c", "--config") ?? "", stage ?? "") })];
    return [];
  }
  if (tool === "heroku") {
    const verb = argv[0];
    const app = option(argv, "-a", "--app");
    const env = envOfName(app);
    if (verb === "config:set" || verb === "config:add") {
      return argv.slice(1).map((w) => SECRET_NAME.exec(w)?.[1]).filter((n): n is string => n !== undefined)
        .map((n) => act("secret.write", { store: "heroku", name_digest: digestOf("heroku", app, n), env }));
    }
    if (verb === "apps:destroy" || verb === "apps:delete" || verb === "destroy") {
      return [act("cloud.resource.delete", { provider: "heroku", service: "apps", kind: "app", env, resource_digest: digestOf("heroku", app ?? option(argv, "--confirm")) })];
    }
    return [];
  }
  if (tool === "vault") {
    const a = readArgs(argv, new Set(["-mount", "-address", "-namespace", "-ns", "-format", "-field", "-output-curl-string", "-cas", "-method"]), new Set(["-non-interactive", "-tls-skip-verify"]));
    const [first, second] = [certainPos(a, 0), certainPos(a, 1)];
    const path = first === "kv" && (second === "put" || second === "patch") ? certainPos(a, 2) : first === "write" ? certainPos(a, 1) : undefined;
    if (path === undefined && !(first === "kv" && (second === "put" || second === "patch")) && first !== "write") return [];
    // `vault write` also logs in (`auth/<method>/login`), and asks the transit and PKI engines to encrypt, sign or issue:
    // none of those stores a secret.
    if (first === "write" && path !== undefined && VAULT_NOT_A_SECRET.test(path)) return [];
    return [act("secret.write", { store: "vault", name_digest: digestOf("vault", flag(a, "-mount") ?? "", path), env: envOfName(flag(a, "-namespace", "-ns")) })];
  }
  if (tool === "doppler") {
    const a = readArgs(argv, new Set(["-p", "--project", "-c", "--config", "--token"]), new Set(["--silent", "--raw", "--no-interactive", "--json"]));
    if (certainPos(a, 0) !== "secrets") return [];
    const verb = certainPos(a, 1);
    const project = flag(a, "-p", "--project");
    const config = flag(a, "-c", "--config");
    const env = envOfName(config);
    if (verb === "upload") return [act("secret.write", { store: "doppler", env })];
    if (verb !== "set") return [];
    // `NAME=value` pairs, or one `NAME` whose value comes from standard input.
    const words = a.pos.slice(2, a.certain);
    const names = words.map((w) => SECRET_NAME.exec(w)?.[1] ?? (/^[A-Za-z_][A-Za-z0-9_]*$/.test(w) && words.length === 1 ? w : undefined)).filter((n): n is string => n !== undefined);
    return names.length ? names.map((n) => act("secret.write", { store: "doppler", name_digest: digestOf("doppler", project ?? "", config ?? "", n), env })) : [act("secret.write", { store: "doppler", env })];
  }
  if (tool === "op") {
    const a = readArgs(argv, new Set(["--vault", "--title", "--category", "--account", "--template", "--url", "--tags", "--format"]), new Set(["--dry-run", "--generate-password", "--reveal"]));
    if (has(a, "--dry-run")) return [];
    const [first, second] = [certainPos(a, 0), certainPos(a, 1)];
    if (first !== "item" || (second !== "create" && second !== "edit")) return [];
    const item = second === "edit" ? certainPos(a, 2) : flag(a, "--title");
    return [act("secret.write", { store: "1password", name_digest: digestOf("1password", flag(a, "--vault") ?? "", item) })];
  }
  if (tool === "pulumi") {
    const a = readArgs(argv, PULUMI_VALUED, PULUMI_BOOL);
    if (certainPos(a, 0) !== "destroy" || has(a, "--preview-only")) return [];
    const stack = flag(a, "-s", "--stack");
    return [act("cloud.resource.delete", { provider: "unknown", service: "pulumi", kind: "stack", env: envOfName(stack), resource_digest: digestOf("pulumi", stack),
      auto_approve: has(a, "--yes", "-y", "--skip-preview", "-f") || undefined, targeted: a.flags.has("--target") || a.flags.has("-t") || undefined })];
  }
  if (tool === "cdk") {
    const a = readArgs(argv, CDK_VALUED, CDK_BOOL);
    if (certainPos(a, 0) !== "destroy") return [];
    const stacks = a.pos.slice(1, a.certain).filter((n) => literal(n) !== undefined).sort();
    const env = envOfName(flag(a, "--profile")) ?? (stacks.length === 1 ? envOfName(stacks[0]) : undefined);
    return [act("cloud.resource.delete", { provider: "aws", service: "cloudformation", kind: "stack", env, resource_digest: stacks.length ? targetDigest("cdk", ...stacks) : undefined,
      auto_approve: has(a, "--force", "-f") || undefined })];
  }
  if (tool === "sst") {
    const a = readArgs(argv, new Set(["--stage", "--config", "--region", "--profile"]), new Set(["--verbose", "--print-logs"]));
    if (certainPos(a, 0) !== "remove") return [];
    const stage = flag(a, "--stage");
    return [act("cloud.resource.delete", { provider: "unknown", service: "sst", kind: "app", env: envOfName(stage), resource_digest: digestOf("sst", stage) })];
  }
  return [];
}

const PULUMI_VALUED = new Set(["-s", "--stack", "-C", "--cwd", "--config-file", "-m", "--message", "-t", "--target", "--exclude", "-p", "--parallel", "--color", "--exec-kind", "-v", "--verbose"]);
const PULUMI_BOOL = new Set(["--yes", "-y", "--skip-preview", "-f", "--remove", "--debug", "--non-interactive", "--target-dependents", "--exclude-protected", "--continue-on-error",
  "--refresh", "--diff", "--json", "--preview-only", "--suppress-outputs", "--suppress-permalink", "--show-config"]);
const CDK_VALUED = new Set(["-a", "--app", "--profile", "-c", "--context", "--role-arn", "-o", "--output", "--ca-bundle-path", "--plugin", "-p", "--proxy"]);
const CDK_BOOL = new Set(["--all", "-e", "--exclusively", "-f", "--force", "--verbose", "-v", "--debug", "--json", "-j", "--strict", "--no-color", "--ci", "--lookups", "--staging"]);

// ---- entry point ----------------------------------------------------------------------------------------------------------

const VIA: Readonly<Record<string, string>> = { flyctl: "fly", sls: "serverless", "sequelize-cli": "sequelize", rake: "rails" };

// ---- an option the reader does not know -------------------------------------------------------------------------------------

const union = (...sets: ReadonlyArray<ReadonlySet<string>>): ReadonlySet<string> => new Set(sets.flatMap((x) => [...x]));
/** The options each reader knows. A tool not listed knows none of its options for this purpose: any option there makes the
 *  reading uncertain when it derived nothing. */
const KNOWN_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  kubectl: union(KUBECTL_VALUED, KUBECTL_BOOL), helm: union(HELM_VALUED, HELM_BOOL), gcloud: union(GCLOUD_VALUED, GCLOUD_BOOL),
  fly: union(FLY_VALUED, FLY_BOOL), flyctl: union(FLY_VALUED, FLY_BOOL), vercel: union(VERCEL_VALUED, VERCEL_BOOL, new Set(["-v"])),
  pulumi: union(PULUMI_VALUED, PULUMI_BOOL), cdk: union(CDK_VALUED, CDK_BOOL),
};
const HELP_OPTIONS = new Set(["--help", "-h", "-help", "--version", "-version"]);
const DRY_RUN = new Set(["--dry-run", "--dryrun", "-dry-run", "--generate-cli-skeleton", "--sql", "-refresh-only", "--refresh-only", "--preview-only"]);
const optionName = (word: string): string => (word.includes("=") ? word.slice(0, word.indexOf("=")) : word);
const isDryRun = (word: string): boolean => {
  if (!DRY_RUN.has(optionName(word))) return false;
  const value = word.includes("=") ? word.slice(word.indexOf("=") + 1).toLowerCase() : "";
  return value !== "none" && value !== "false";
};

/** Whether an option this module's reader for `tool` does not know could have stopped it reading the command. */
function uncertain(sc: SimpleCommand, tool: string, words: readonly string[]): boolean {
  if (tool === "wrangler") return readWrangler(sc) === null;
  if (tool === "aws") {
    // The AWS reader reads the service and operation only past the global options it knows.
    let seen = 0;
    for (let i = 0; i < words.length && seen < 2; i++) {
      const name = optionName(words[i]);
      if (!words[i].startsWith("-")) { seen++; continue; }
      if (AWS_GLOBAL_VALUED.has(name)) { if (!words[i].includes("=")) i++; continue; }
      if (!AWS_GLOBAL_BOOL.has(name)) return true;
    }
    return false;
  }
  const known = KNOWN_OPTIONS[tool];
  return words.some((w) => w.length > 1 && w.startsWith("-") && !/^-\d/.test(w) && !(known?.has(optionName(w)) ?? false));
}

const anyOf = (words: readonly string[], ...names: string[]): boolean => words.some((w) => names.includes(w));

/** The action a tool's destructive word names, with every name left out: what an uncertain reading still knows. */
function fallbackOf(tool: string, w: readonly string[]): TargetOperation | undefined {
  const del = (provider: string, extra: Params = {}): TargetOperation => act("cloud.resource.delete", { provider, ...extra });
  const deploy = (provider: string): TargetOperation => act("deploy.release", { provider, environment: "unknown" });
  const migrate = (provider: string, direction: Direction): TargetOperation => act("db.migrate", { provider, direction });
  switch (tool) {
    case "kubectl":
      return anyOf(w, "delete") ? act("k8s.delete", {}) : anyOf(w, "exec", "attach", "debug") ? act("k8s.exec", {}) : undefined;
    case "helm": return anyOf(w, "uninstall", "delete", "del", "un") ? act("k8s.delete", { kind: "helm-release" }) : undefined;
    case "gcloud":
      if (GCLOUD_LOCAL.has(w[0] ?? "")) return undefined;
      return anyOf(w, "delete", "rm") ? del("gcp") : anyOf(w, "deploy") ? deploy("gcp") : undefined;
    case "aws": {
      const op = w.find((x) => x === "rb" || x === "rm" || AWS_DELETE.test(x));
      if (op === undefined || (anyOf(w, "sqs") && /^delete-message/.test(op))) return undefined;
      return anyOf(w, "iam") ? act("iam.change", { provider: "aws", kind: "other" }) : del("aws");
    }
    case "fly": case "flyctl":
      return anyOf(w, "destroy", "delete", "remove", "rm") ? del("fly") : anyOf(w, "deploy") ? deploy("fly") : undefined;
    case "wrangler":
      if (anyOf(w, "secret") && anyOf(w, "put", "delete", "bulk")) return act("secret.write", { store: "wrangler" });
      return anyOf(w, "deploy", "publish") ? deploy("cloudflare") : anyOf(w, "delete") ? del("cloudflare") : undefined;
    case "vercel":
      if (anyOf(w, "env") && anyOf(w, "add", "rm", "remove")) return act("secret.write", { store: "vercel" });
      if (w.length === 0 || anyOf(w, "deploy", "redeploy", "promote", "rollback")) return deploy("vercel");
      return anyOf(w, "remove", "rm") ? del("vercel") : undefined;
    case "gh": return anyOf(w, "repo") && anyOf(w, "delete") ? del("github", { service: "repo", kind: "repo" }) : undefined;
    case "prisma": return anyOf(w, "reset") ? migrate("prisma", "reset") : undefined;
    case "drizzle-kit": return anyOf(w, "drop") ? migrate("drizzle", "down") : undefined;
    case "alembic": return anyOf(w, "downgrade") ? migrate("alembic", "down") : undefined;
    case "flyway": return anyOf(w, "clean") ? migrate("flyway", "reset") : anyOf(w, "undo") ? migrate("flyway", "down") : undefined;
    case "knex": return anyOf(w, "migrate:rollback", "migrate:down") ? migrate("knex", "down") : undefined;
    case "sequelize": case "sequelize-cli":
      return anyOf(w, "db:drop") ? migrate("sequelize", "reset") : anyOf(w, "db:migrate:undo", "db:migrate:undo:all") ? migrate("sequelize", "down") : undefined;
    case "eb": return anyOf(w, "terminate") ? del("aws", { service: "elasticbeanstalk" }) : anyOf(w, "deploy") ? deploy("aws") : undefined;
    case "serverless": case "sls": return anyOf(w, "remove") ? del("unknown", { service: "serverless" }) : anyOf(w, "deploy") ? deploy("unknown") : undefined;
    case "heroku": return anyOf(w, "apps:destroy", "apps:delete", "destroy") ? del("heroku") : undefined;
    case "pulumi": return anyOf(w, "destroy") ? del("unknown", { service: "pulumi" }) : undefined;
    case "cdk": return anyOf(w, "destroy") ? del("aws", { service: "cloudformation" }) : undefined;
    case "sst": return anyOf(w, "remove") ? del("unknown", { service: "sst" }) : undefined;
    default: return undefined;
  }
}

/** When a tool's reader derived nothing because an option it does not know stopped it, but one of the tool's destructive
 *  words is among the command's words (before `--`), the action that word names, with no names. Nothing for a help (a
 *  help option, or `help` in the subcommand slot) or a dry run. */
function uncertainFallback(sc: SimpleCommand, tool: string, argv: readonly string[]): TargetOperation[] {
  const end = argv.indexOf("--");
  const words = end < 0 ? argv : argv.slice(0, end);
  if (words.some((w) => HELP_OPTIONS.has(w) || isDryRun(w))) return [];
  if (!uncertain(sc, tool, words)) return [];
  const positional = words.filter((w) => !(w.length > 1 && w.startsWith("-")));
  if (positional[0] === "help") return [];
  const op = fallbackOf(tool, positional);
  return op ? [op] : [];
}

/** The risk class of one instance: the type's class, narrowed where the parameters say more. */
function riskClassOf(op: TargetOperation): string | undefined {
  const p = op.params;
  switch (op.action_type) {
    case "cloud.resource.delete": case "k8s.delete": case "k8s.exec": return "destructive";
    // A saved plan applied without showing its changes may destroy.
    case "cloud.resource.modify": return p.saved_plan === true ? "destructive" : "sensitive";
    case "cloud.resource.create": case "k8s.apply": case "secret.write": return "sensitive";
    case "iam.change": return "identity";
    // Down or reset loses data, except against a development database the command names.
    case "db.migrate": return p.direction === "up" || p.env === "development" ? "sensitive" : "destructive";
    case "deploy.release": return p.environment === "production" || p.environment === "unknown" ? "destructive" : "sensitive";
    default: return undefined;
  }
}

/**
 * The taxonomy actions one simple command reaches, or none. Pure and deterministic (the probe is reserved; the mapper passes
 * none). Each action carries `via`, `derived_from: "shell.exec"` and, for the 1.1 types and `deploy.release`, `risk_class`.
 */
export function deriveTargetOperations(sc: SimpleCommand, _probe: TargetProbe = {}): TargetOperation[] {
  void _probe;
  const found = toolOf(sc);
  if (!found) return [];
  const { tool, argv } = found;
  let ops: TargetOperation[];
  try {
    switch (tool) {
      case "aws": ops = aws(sc, argv); break;
      case "gcloud": ops = gcloud(sc, argv); break;
      case "az": ops = az(argv); break;
      case "kubectl": ops = kubectl(argv); break;
      case "helm": ops = helm(argv); break;
      case "terraform": case "tofu": ops = terraform(sc, tool, argv); break;
      case "terragrunt": ops = terragrunt(sc, argv); break;
      // Wrangler is read through its own launcher-aware reader (typed-infra.ts), which also refuses an option it does not know.
      case "wrangler": ops = wrangler(sc); break;
      case "vercel": ops = vercel(argv); break;
      case "fly": case "flyctl": ops = fly(argv); break;
      case "gh": ops = gh(argv); break;
      case "prisma": case "drizzle-kit": case "rails": case "rake": case "alembic": case "flyway": case "knex": case "sequelize": case "sequelize-cli":
        ops = migrations(sc, tool, argv); break;
      default: ops = others(sc, tool, argv);
    }
    if (ops.length === 0) ops = uncertainFallback(sc, tool, argv);
  } catch { return []; }
  const via = VIA[tool] ?? tool;
  return ops.map((op) => {
    const risk_class = riskClassOf(op);
    return { action_type: op.action_type, params: { ...op.params, via, derived_from: "shell.exec", ...(risk_class ? { risk_class } : {}) } };
  });
}
