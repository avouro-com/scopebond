// Wrangler's typed `cloudflare_resource` and `database` operations (Workers, Pages, D1 and R2), derived from the ACTUAL
// command line before it runs, for the observation record, plus the D1 commands the remote-database guard reads.
//
// The one vendor reader left in the engine. Rule packs carry what a command does for a decision; they have no observation
// output yet, and these operations read facts no pack can (the Wrangler config's name and account, the migration folder, the
// digest of what a Pages deploy or an R2 put sends). Same rules as typed-ops.ts: a fact that cannot be read stays unknown or
// leaves no operation, and nothing raw is exported.
//
//   cloudflare   resource kind, verb, keyed account and resource ids, an artifact digest of the
//                local files a Pages deploy or an R2 put sends. `wrangler` has no DNS command,
//                so dns_record and Worker/KV/secret changes made any other way are not seen.
//   database     a D1 statement or migration set, as the generic database readers describe theirs (typed-infra.ts).

import { join } from "node:path";
import { canonProgram, type SimpleCommand } from "./shell.js";
import { classifySql } from "./sql-classify.js";
import { scan, flagValue, type Scanned } from "./scan.js";
import { launched } from "./launchers.js";
import { common, envClassOf, envOf, filesOf, inlineAssignment, resolvePath, riskOf, UNBOUND, type DatabaseFacts, type FileProbe, type InfraContext, type Operation, type ReadContext } from "./infra-probe.js";

/** Blanks at the start of a line, not crossing a line end (a regular-expression source). */
const LINE_BLANKS = String.raw`[^\S\n\r\u2028\u2029]*`;

/** The argument list of a `wrangler` invocation: the program itself, or Wrangler started through a package runner, found by the
 *  same launcher reader every other derivation uses (launchers.ts). */
function wranglerArgv(sc: SimpleCommand): string[] | null {
  if (canonProgram(sc.program) === "wrangler") return sc.argv;
  const run = launched(sc);
  return run && run.tool === "wrangler" ? run.argv : null;
}

const WR_VALUED = ["--env", "-e", "--config", "-c", "--name", "--command", "--file", "--project-name", "--branch", "--commit-hash", "--commit-message", "--compatibility-date", "--compatibility-flags",
  "--var", "--define", "--route", "--routes", "--outdir", "--tag", "--message", "--content-type", "--content-disposition", "--cache-control", "--expires", "--content-language", "--storage-class", "--jurisdiction", "-J",
  "--persist-to", "--database", "--binding", "--format", "--limit", "--location", "--account-id", "--production-branch", "--assets", "--site", "--cwd", "--namespace-id"];
const WR_FLAGS = new Set([...WR_VALUED, "--remote", "--local", "--preview", "--dry-run", "--json", "--yes", "-y", "--help", "-h", "--version", "-v", "--skip-confirmation", "--keep-vars", "--no-bundle", "--node-compat",
  "--experimental-json-config", "--persist", "--no-minify", "--latest", "--strict", "--force", "-f", "--no-x-remote-bindings", "--x-remote-bindings", "--experimental-provision", "--x-provision", "--unsafe", "--include-secrets", "--dev-url", "--minify", "--workers-dev", "--triggers", "--legacy-env"]);

interface WranglerConfig { name?: string; account_id?: string; migrationsDir?: string; envName?: string }

function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '"') { let j = i + 1; while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1; out += text.slice(i, j + 1); i = j + 1; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? text.length : e + 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function readWranglerConfig(cwd: string, files: FileProbe, configFlag: string | undefined, env: string | undefined): WranglerConfig {
  const candidates = configFlag ? [resolvePath(cwd, configFlag)] : ["wrangler.jsonc", "wrangler.json", "wrangler.toml"].map((f) => join(cwd, f));
  for (const file of candidates) {
    const text = files.readText(file, 1024 * 1024);
    if (text === null) continue;
    try {
      if (/\.toml$/i.test(file)) {
        // A line's leading blanks are matched without crossing a line end: `^\s*` with the m flag rescanned every blank
        // line after each line start, quadratic in a config file of blank lines.
        const top = text.split(/^[^\S\n\r\u2028\u2029]*\[/m)[0];
        // eslint-disable-next-line security/detect-non-literal-regexp -- k is one of this function's literal keys (name, account_id)
        const pick = (src: string, k: string): string | undefined => new RegExp(`^${LINE_BLANKS}${k}\\s*=\\s*"([^"\\n]+)"`, "m").exec(src)?.[1];
        const base = pick(top, "name");
        let name = base;
        if (env) {
          // eslint-disable-next-line security/detect-non-literal-regexp -- the environment name is reduced to [A-Za-z0-9_-] first, so it adds no syntax
          const section = new RegExp(`^${LINE_BLANKS}\\[env\\.${env.replace(/[^A-Za-z0-9_-]/g, "")}\\]([\\s\\S]*?)(?=^${LINE_BLANKS}\\[|$(?![\\s\\S]))`, "m").exec(text)?.[1];
          name = (section && pick(section, "name")) ?? (base ? `${base}-${env}` : undefined);
        }
        const dir = /^[^\S\n\r\u2028\u2029]*migrations_dir\s*=\s*"([^"\n]+)"/m.exec(text)?.[1];
        return { name, account_id: pick(top, "account_id"), migrationsDir: dir };
      }
      const json = JSON.parse(stripJsonc(text)) as { name?: unknown; account_id?: unknown; env?: Record<string, { name?: unknown }>; d1_databases?: Array<{ migrations_dir?: unknown }> };
      const base = typeof json.name === "string" ? json.name : undefined;
      let name = base;
      if (env) { const e = json.env?.[env]?.name; name = typeof e === "string" ? e : base ? `${base}-${env}` : undefined; }
      const dir = json.d1_databases?.find((d) => typeof d.migrations_dir === "string")?.migrations_dir;
      return { name, ...(typeof json.account_id === "string" ? { account_id: json.account_id } : {}), ...(typeof dir === "string" ? { migrationsDir: dir } : {}) };
    } catch { return {}; }
  }
  return {};
}

interface Wrangler { area: string; sub: string; pos: string[]; s: Scanned; env: string | undefined; cfg: WranglerConfig; accountId: string }

function parseWrangler(sc: SimpleCommand, ctx: ReadContext): Wrangler | null {
  const argv = wranglerArgv(sc);
  if (!argv) return null;
  const s = scan(argv, WR_VALUED);
  // A flag this reader does not know might take a value, which would shift the positionals: no guess.
  for (const f of s.flags.keys()) if (!WR_FLAGS.has(f)) return null;
  const pos = s.positionals;
  if (pos.length === 0) return null;
  const env = flagValue(s, "--env", "-e");
  const cfg = readWranglerConfig(ctx.cwd, filesOf(ctx), flagValue(s, "--config", "-c"), env);
  const accountId = inlineAssignment(sc.raw, "CLOUDFLARE_ACCOUNT_ID") ?? flagValue(s, "--account-id") ?? cfg.account_id ?? envOf(ctx, "CLOUDFLARE_ACCOUNT_ID") ?? UNBOUND;
  return { area: pos[0], sub: pos[1] ?? "", pos, s, env, cfg, accountId };
}

type CfKind = "worker" | "pages_project" | "pages_deployment" | "d1_database" | "r2_bucket" | "r2_object";

function cloudflareOp(w: Wrangler, ctx: InfraContext, request: unknown, kind: CfKind, verb: string, name: string | undefined, extra: Operation = {}, environmentClass?: string): Operation {
  const bound = name !== undefined && name !== "";
  return {
    type: "cloudflare_resource", resource_id: ctx.key.resourceId(`cf:${kind}`, bound ? name : `\0${UNBOUND}`), ...common(ctx, request, environmentClass ?? envClassOf(w.env)),
    verb, resource_kind: kind, account_id: w.accountId === UNBOUND ? UNBOUND : ctx.key.resourceId("cf:account", w.accountId),
    ...(w.env ? { environment_binding: ctx.key.resourceId("cf:env", w.env) } : {}),
    ...extra,
  };
}

/** A local file path a Wrangler command sends, resolved and digested (plain SHA-256: the file is what is deployed). */
const fileDigest = (ctx: ReadContext, path: string | undefined): Operation => {
  if (!path) return {};
  const d = filesOf(ctx).sha256File(resolvePath(ctx.cwd, path));
  return d ? { artifact_digest: d } : {};
};

function d1Facts(w: Wrangler, ctx: ReadContext): DatabaseFacts | null {
  const remote = w.s.flags.has("--remote") || w.s.flags.has("--preview");
  const local = w.s.flags.has("--local");
  if (remote && local) return null;
  const scope: DatabaseFacts["scope"] = remote ? "remote" : local ? "local" : "unknown";
  const environment = local ? "development" : envClassOf(w.env);
  const files = filesOf(ctx);
  if (w.area === "d1" && w.sub === "execute") {
    const db = w.pos[2];
    const command = flagValue(w.s, "--command");
    const file = flagValue(w.s, "--file");
    if (!db || (command === undefined) === (file === undefined)) return null;
    const text = command ?? files.readText(resolvePath(ctx.cwd, file as string), 5 * 1024 * 1024);
    if (text === null) return null;
    const c = classifySql(text);
    if (!c) return null;
    return { provider: "cloudflare_d1", verb: c.verb, predicate_class: c.predicate_class, risk: riskOf(c), scope, environment, databaseKey: db, databaseKind: "cf:d1_database", digestInput: { sql: text } };
  }
  if (w.area === "d1" && w.sub === "migrations" && w.pos[2] === "apply") {
    const db = w.pos[3];
    if (!db) return null;
    const dir = w.cfg.migrationsDir ?? "migrations";
    const set = files.listSql(resolvePath(ctx.cwd, dir));
    if (!set) return null;
    const c = classifySql(set.map((f) => f.text).join(";\n"));
    return { provider: "cloudflare_d1", verb: "migrate", predicate_class: "not_applicable", risk: c ? riskOf(c) : "unknown", scope, environment, databaseKey: db, databaseKind: "cf:d1_database", digestInput: { migrations: set }, migrate: true };
  }
  return null;
}

function cloudflareFromWrangler(w: Wrangler, ctx: InfraContext, request: unknown): Operation | null {
  const { area, sub, pos, s } = w;
  if (s.flags.has("--dry-run") || s.flags.has("--help") || s.flags.has("-h")) return null;
  const name = (n: string | undefined): string | undefined => n ?? undefined;
  if (area === "deploy" || area === "publish") return cloudflareOp(w, ctx, request, "worker", "update", name(flagValue(s, "--name") ?? w.cfg.name));
  if (area === "delete" && pos.length <= 2) return cloudflareOp(w, ctx, request, "worker", "delete", name(flagValue(s, "--name") ?? pos[1] ?? w.cfg.name));
  if (area === "pages" && sub === "deploy") {
    const dir = pos[2];
    if (!dir) return null;
    const digest = filesOf(ctx).sha256Dir(resolvePath(ctx.cwd, dir));
    const branch = flagValue(s, "--branch");
    return cloudflareOp(w, ctx, request, "pages_deployment", "create", name(flagValue(s, "--project-name")), {
      ...(digest ? { artifact_digest: digest } : {}), ...(branch ? { environment_binding: ctx.key.resourceId("cf:pages-branch", branch) } : {}),
    });
  }
  if (area === "pages" && sub === "project" && (pos[2] === "create" || pos[2] === "delete") && pos[3]) return cloudflareOp(w, ctx, request, "pages_project", pos[2], pos[3]);
  if (area === "d1" && (sub === "create" || sub === "delete") && pos[2]) return cloudflareOp(w, ctx, request, "d1_database", sub, pos[2]);
  if (area === "r2" && sub === "bucket" && (pos[2] === "create" || pos[2] === "delete") && pos[3]) return cloudflareOp(w, ctx, request, "r2_bucket", pos[2], pos[3]);
  if (area === "r2" && sub === "bucket" && pos[2] === "dev-url" && (pos[3] === "enable" || pos[3] === "disable") && pos[4]) {
    return cloudflareOp(w, ctx, request, "r2_bucket", "set_visibility", pos[4], pos[3] === "enable"
      ? { visibility_before: "unknown", visibility_after: "public" } : { visibility_before: "unknown", visibility_after: "private" });
  }
  if (area === "r2" && sub === "object" && (pos[2] === "put" || pos[2] === "delete") && pos[3]) {
    return cloudflareOp(w, ctx, request, "r2_object", pos[2] === "put" ? "write" : "delete", pos[3], pos[2] === "put" ? fileDigest(ctx, flagValue(s, "--file")) : {});
  }
  return null;
}

/** The D1 facts of a Wrangler command, or null when it is not Wrangler or not a D1 statement or migration this reader can read. */
export function wranglerDatabaseFacts(sc: SimpleCommand, ctx: ReadContext): DatabaseFacts | null {
  const w = parseWrangler(sc, ctx);
  return w ? d1Facts(w, ctx) : null;
}

/** The Cloudflare operation of a Wrangler command: undefined when the command is not Wrangler, null when it is and changes
 *  nothing this reader describes. */
export function wranglerOperation(sc: SimpleCommand, ctx: InfraContext, request: unknown): Operation | null | undefined {
  const w = parseWrangler(sc, ctx);
  return w ? cloudflareFromWrangler(w, ctx, request) : undefined;
}

/** A D1 command run against a database that is not local whose SQL could not be read: the guard's `unknown` action, or null. */
export function wranglerUnreadableD1(sc: SimpleCommand, ctx: ReadContext): { provider: string; verb: string; scope: string; risk: string } | null {
  const w = parseWrangler(sc, ctx);
  if (!w || w.area !== "d1" || !(w.sub === "execute" || (w.sub === "migrations" && w.pos[2] === "apply")) || w.s.flags.has("--local")) return null;
  return { provider: "cloudflare_d1", verb: "unknown", scope: w.s.flags.has("--remote") ? "remote" : "unknown", risk: "unknown" };
}
