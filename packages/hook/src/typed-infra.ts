// Typed `network`, `cloudflare_resource` and `database` operations, derived from the ACTUAL
// command line or tool input before it runs.
//
// Same rules as typed-ops.ts: a fact that cannot be read from the request stays unknown or
// leaves no operation at all, and nothing raw is exported. What each operation carries:
//
//   network      scheme, lowercase IDNA host, effective port, method and read/write/upload. Never
//                the path, query, credentials, headers or body. A redirect hop is not followed
//                or bound (`redirect_binding` is always omitted), so a redirected request is
//                not qualified against the origin's approval.
//   cloudflare   resource kind, verb, keyed account and resource ids, an artifact digest of the
//                local files a Pages deploy or an R2 put sends. `wrangler` has no DNS command,
//                so dns_record and Worker/KV/secret changes made any other way are not seen.
//   database     provider, verb, predicate class and a keyed digest of the statement or the
//                local migration set. Never SQL text, table or column names, or rows. A
//                statement the classifier cannot place leaves no operation (the closed
//                schema has no "unknown" verb).

import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { canonProgram, decomposeShell, type SimpleCommand } from "./shell.js";
import { classifySql, type SqlClass } from "./sql-classify.js";
import { scan, flagValue, type Scanned } from "./scan.js";
import type { BindingKey } from "./observation.js";

type Operation = Record<string, unknown>;

/** Everything the derivations read from disk or the environment. Injected in tests and by the proof runner. */
export interface FileProbe {
  /** UTF-8 text of a file, or null when missing, unreadable or larger than `max` bytes. */
  readText(path: string, max: number): string | null;
  /** Lowercase SHA-256 of a file's bytes, or null. */
  sha256File(path: string): string | null;
  /** Lowercase SHA-256 over the relative paths and bytes of every file under a directory, or null. */
  sha256Dir(path: string): string | null;
  /** The `.sql` files of a directory in name order, or null when it cannot be read or holds none. */
  listSql(path: string): Array<{ name: string; text: string }> | null;
}

const MAX_FILE = 20 * 1024 * 1024;
const MAX_TREE_FILES = 5000;
const MAX_TREE_BYTES = 100 * 1024 * 1024;

/** A regular file's bytes when it is at most `max` bytes, else null. The file is opened once and the type and size are
 *  checked on that descriptor, so what passed the check is what is read. Non-blocking open (where the platform has it):
 *  a named pipe is refused by the check instead of waiting for a writer. */
function readRegularFile(path: string, max: number): Buffer | null {
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

export const systemFiles: FileProbe = {
  readText(path, max) {
    try { return readRegularFile(path, max)?.toString("utf8") ?? null; } catch { return null; }
  },
  sha256File(path) {
    try { const bytes = readRegularFile(path, MAX_FILE); return bytes === null ? null : createHash("sha256").update(bytes).digest("hex"); } catch { return null; }
  },
  sha256Dir(path) {
    try {
      const files: string[] = [];
      const walk = (dir: string, rel: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const r = rel === "" ? entry.name : `${rel}/${entry.name}`;
          if (entry.isDirectory()) walk(join(dir, entry.name), r);
          else if (entry.isFile()) files.push(r);
          if (files.length > MAX_TREE_FILES) throw new Error("too many files");
        }
      };
      if (!statSync(path).isDirectory()) return null;
      walk(path, "");
      if (files.length === 0) return null;
      files.sort();
      const hash = createHash("sha256");
      let total = 0;
      for (const f of files) {
        const bytes = readFileSync(join(path, f));
        total += bytes.length;
        if (total > MAX_TREE_BYTES) return null;
        hash.update(`${f}\0${bytes.length}\0`).update(bytes);
      }
      return hash.digest("hex");
    } catch { return null; }
  },
  listSql(path) {
    try {
      const names = readdirSync(path).filter((n) => /\.sql$/i.test(n)).sort();
      if (names.length === 0) return null;
      const out: Array<{ name: string; text: string }> = [];
      for (const name of names) {
        const text = systemFiles.readText(join(path, name), 5 * 1024 * 1024);
        if (text === null) return null;
        out.push({ name, text });
      }
      return out;
    } catch { return null; }
  },
};

/** No files, deterministic: what the proof fixtures read, so a proof never depends on the machine it runs on. */
export const fixtureFiles: FileProbe = { readText: () => null, sha256File: () => null, sha256Dir: () => null, listSql: () => null };

/** What the derivations need beyond the binding key. */
export interface InfraContext {
  key: BindingKey;
  cwd: string;
  referenceSetVersion: string;
  files?: FileProbe;
  /** Environment variable lookup for account and PostgreSQL defaults; `process.env` when absent. */
  env?: (name: string) => string | undefined;
}

/** What the database and Wrangler readers need: no key, because they only read facts. */
export type ReadContext = Pick<InfraContext, "cwd" | "files" | "env">;

const UNBOUND = "unbound";
const filesOf = (ctx: ReadContext): FileProbe => ctx.files ?? systemFiles;
const envOf = (ctx: ReadContext, name: string): string | undefined => (ctx.env ? ctx.env(name) : process.env[name]);
const resolvePath = (cwd: string, p: string): string => (isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) ? p : join(cwd, p));

function common(ctx: InfraContext, request: unknown, environment_class: string): Operation {
  return {
    environment_class, reference_set_version: ctx.referenceSetVersion,
    request_digest: ctx.key.requestDigest(request), digest_key_generation: ctx.key.generation,
  };
}

// ---- network -------------------------------------------------------------------------------------------

// eslint-disable-next-line security/detect-unsafe-regex -- bounded: at most 253 characters
const HOST_OK = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

/** A URL reduced to scheme, IDNA-lowercase host and effective port. Null for anything else
 *  (an unexpanded variable, a glob, an IPv6 literal, a non-HTTP scheme, a host that is not a
 *  plain hostname). A scheme-less operand reads as `http`, as curl does. */
export function parseDestination(raw: string, assumeHttp: boolean): { scheme: "http" | "https"; host: string; port: number } | null {
  let text = raw.trim();
  if (text === "" || /[$`{}[\]*\s]/.test(text.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i, ""))) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    if (!assumeHttp || text.startsWith("//") || text.startsWith("/")) return null;
    text = `http://${text}`;
  }
  let u: URL;
  try { u = new URL(text); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.replace(/\.$/, "");
  if (!HOST_OK.test(host) || host.includes("..")) return null;
  const scheme = u.protocol === "https:" ? "https" : "http";
  const port = u.port !== "" ? Number(u.port) : scheme === "https" ? 443 : 80;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? { scheme, host, port } : null;
}

const METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);

function networkOperation(dest: { scheme: "http" | "https"; host: string; port: number }, method: string, hasBody: boolean, ctx: InfraContext, request: unknown): Operation | null {
  if (!METHODS.has(method)) return null;
  const net_operation = method === "GET" || method === "HEAD" || method === "OPTIONS" ? "read"
    : method === "DELETE" ? "write" : hasBody ? "upload" : "write";
  return {
    type: "network", resource_id: ctx.key.resourceId("net-dest", `${dest.host}:${dest.port}`), ...common(ctx, request, "unknown"),
    scheme: dest.scheme, host: dest.host, port: dest.port, method, net_operation,
  };
}

/** A WebFetch tool call: a GET of the URL in its input. */
export function fetchOperation(url: string, ctx: InfraContext, request: unknown): Operation | null {
  const dest = parseDestination(url, false);
  return dest ? networkOperation(dest, "GET", false, ctx, request) : null;
}

// Curl options whose next argument is a value (so it is never read as the URL).
const CURL_VALUED = new Set(["-X", "--request", "-H", "--header", "-d", "--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode", "--json", "-F", "--form", "--form-string",
  "-u", "--user", "-o", "--output", "-T", "--upload-file", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "-c", "--cookie-jar", "-w", "--write-out", "-m", "--max-time", "--connect-timeout",
  "-r", "--range", "-y", "--speed-time", "-Y", "--speed-limit", "-z", "--time-cond", "-E", "--cert", "--key", "--cacert", "--capath", "--retry", "--retry-delay", "--retry-max-time", "--max-redirs",
  "--limit-rate", "--oauth2-bearer", "--proxy-user", "-U", "--interface", "--dns-servers", "--aws-sigv4", "--cert-type", "--key-type", "--pass", "--proto", "--proto-redir", "--ciphers",
  "--tls-max", "--expect100-timeout", "-P", "--ftp-port", "--stderr", "--trace", "--trace-ascii", "--create-file-mode", "--max-filesize", "--url-query", "--variable", "--etag-save", "--etag-compare", "--hsts", "--alt-svc", "--happy-eyeballs-timeout-ms"]);
// Options that send the request somewhere other than the URL names, or read more requests from elsewhere.
const CURL_REROUTE = new Set(["-x", "--proxy", "--preproxy", "--connect-to", "--resolve", "--unix-socket", "--abstract-unix-socket", "-K", "--config", "--next", "-:", "--doh-url", "-q", "--disable"]);
const CURL_BODY = new Set(["-d", "--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode", "--json", "-F", "--form", "--form-string", "-T", "--upload-file"]);
const CURL_SHORT_VALUED = "XHdFuoTAebcwmrxyYzEUPK";

interface FetchRequest { url: string; method: string; hasBody: boolean }

function parseCurl(argv: string[]): FetchRequest | null {
  const urls: string[] = [];
  let method: string | undefined;
  let head = false;
  let get = false;
  let body = false;
  let upload = false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--") { urls.push(...argv.slice(i + 1)); break; }
    if (t.startsWith("--")) {
      const at = t.indexOf("=");
      const name = at > 0 ? t.slice(0, at) : t;
      let value: string | undefined = at > 0 ? t.slice(at + 1) : undefined;
      if (CURL_REROUTE.has(name)) return null;
      if (CURL_VALUED.has(name) && value === undefined) value = argv[++i];
      if (name === "--request") method = (value ?? "").toUpperCase();
      else if (name === "--url") { if (value) urls.push(value); }
      else if (name === "--head") head = true;
      else if (name === "--get") get = true;
      else if (name === "--upload-file") { upload = true; body = true; }
      else if (CURL_BODY.has(name)) body = true;
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      if (CURL_REROUTE.has(t)) return null;
      for (let k = 1; k < t.length; k++) {
        const c = t[k];
        if (CURL_REROUTE.has(`-${c}`)) return null;
        if (CURL_SHORT_VALUED.includes(c)) {
          const value = k + 1 < t.length ? t.slice(k + 1) : argv[++i];
          if (c === "X") method = (value ?? "").toUpperCase();
          else if (c === "T") { upload = true; body = true; }
          else if (c === "d" || c === "F") body = true;
          break;
        }
        if (c === "I") head = true;
        else if (c === "G") get = true;
      }
      continue;
    }
    urls.push(t);
  }
  // eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored; the host repeat backs off only to each dot, and the IPv4 form is bounded
  const candidates = urls.filter((u) => /^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?::\d+)?(?:[/?#]|$)/.test(u) || /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#]|$)/i.test(u));
  if (candidates.length !== 1 || candidates.length !== urls.length) return null;
  const effective = method && method !== "" ? method : head ? "HEAD" : get ? "GET" : upload ? "PUT" : body ? "POST" : "GET";
  return { url: candidates[0], method: effective, hasBody: (body && !get) || upload };
}

const WGET_VALUED = new Set(["-O", "--output-document", "-o", "--output-file", "-P", "--directory-prefix", "-t", "--tries", "-T", "--timeout", "-w", "--wait", "-U", "--user-agent", "--header", "--http-user", "--http-password", "--user", "--password",
  "-e", "--execute", "--method", "--post-data", "--post-file", "--body-data", "--body-file", "-l", "--level", "-A", "--accept", "-R", "--reject", "-I", "--include-directories", "-X", "--exclude-directories", "--referer", "--load-cookies", "--save-cookies",
  "--certificate", "--private-key", "--ca-certificate", "--ca-directory", "--bind-address", "-Q", "--quota", "--limit-rate", "--waitretry", "--connect-timeout", "--read-timeout", "--dns-timeout", "--secure-protocol", "--proxy-user", "--proxy-password"]);

function parseWget(argv: string[]): FetchRequest | null {
  const urls: string[] = [];
  let method: string | undefined;
  let body = false;
  let spider = false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--") { urls.push(...argv.slice(i + 1)); break; }
    if (t.startsWith("-") && t.length > 1) {
      const at = t.startsWith("--") ? t.indexOf("=") : -1;
      const name = at > 0 ? t.slice(0, at) : t;
      let value: string | undefined = at > 0 ? t.slice(at + 1) : undefined;
      if (["-i", "--input-file", "-B", "--base", "-e", "--execute"].includes(name)) return null;
      if (name.startsWith("--")) {
        if (WGET_VALUED.has(name) && value === undefined) value = argv[++i];
        if (name === "--method") method = (value ?? "").toUpperCase();
        else if (["--post-data", "--post-file", "--body-data", "--body-file"].includes(name)) { body = true; method ??= "POST"; }
        else if (name === "--spider") spider = true;
        continue;
      }
      // Short options: the first letter that takes a value ends the cluster.
      for (let k = 1; k < t.length; k++) {
        if (WGET_VALUED.has(`-${t[k]}`)) { if (k + 1 >= t.length) i++; break; }
      }
      continue;
    }
    urls.push(t);
  }
  // eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored; the host repeat backs off only to each dot
  const candidates = urls.filter((u) => /^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?::\d+)?(?:[/?#]|$)/.test(u));
  if (candidates.length !== 1 || candidates.length !== urls.length) return null;
  return { url: candidates[0], method: method ?? (spider ? "HEAD" : "GET"), hasBody: body };
}

const PS_SWITCH = new Set(["usebasicparsing", "skipcertificatecheck", "skipheadervalidation", "skiphttperrorcheck", "allowunencryptedauthentication", "passthru", "resume", "preservehttpmethodonredirect", "noproxy", "allowinsecureredirect", "usedefaultcredentials", "disablekeepalive", "verbose", "debug"]);
const PS_REROUTE = new Set(["proxy", "sessionvariable", "websession"]);

function parsePowerShell(argv: string[]): FetchRequest | null {
  let uri: string | undefined;
  let method: string | undefined;
  let body = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    // eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored letters, then an optional colon and the rest
    const m = /^-([A-Za-z]+)(?::(.*))?$/.exec(t);
    if (!m) { positional.push(t); continue; }
    const name = m[1].toLowerCase();
    if (PS_REROUTE.has(name)) return null;
    let value = m[2];
    if (!PS_SWITCH.has(name) && value === undefined) value = argv[++i];
    if (name === "uri" || name === "u") uri = value;
    else if (name === "method" || name === "m") method = (value ?? "").toUpperCase();
    else if (name === "body" || name === "infile") body = true;
  }
  if (uri === undefined) { if (positional.length !== 1) return null; uri = positional[0]; }
  else if (positional.length > 0) return null;
  return { url: uri, method: method ?? (body ? "POST" : "GET"), hasBody: body };
}

function fetchFromCommand(sc: SimpleCommand, dialect: "posix" | "powershell"): FetchRequest | null {
  const program = canonProgram(sc.program);
  if (["invoke-webrequest", "iwr", "invoke-restmethod", "irm"].includes(program)) return parsePowerShell(sc.argv);
  const exe = /\.exe$/i.test(sc.programRaw);
  if (dialect === "powershell" && !exe && (program === "curl" || program === "wget")) return parsePowerShell(sc.argv);
  if (program === "curl") return parseCurl(sc.argv);
  if (program === "wget") return parseWget(sc.argv);
  return null;
}

// ---- wrangler ----------------------------------------------------------------------------------------------

/** Blanks at the start of a line, not crossing a line end (a regular-expression source). */
const LINE_BLANKS = String.raw`[^\S\n\r\u2028\u2029]*`;

/** The argument list of a `wrangler` invocation, through the usual launchers. */
function wranglerArgv(sc: SimpleCommand): string[] | null {
  const program = canonProgram(sc.program);
  // eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored, a fixed word then one repeat
  const isWrangler = (t: string | undefined): boolean => t !== undefined && /^wrangler(?:@[^\s]+)?$/i.test(t);
  if (program === "wrangler") return sc.argv;
  let rest: string[];
  if (program === "npx" || program === "bunx" || program === "pnpx") rest = sc.argv;
  else if (program === "pnpm" || program === "yarn" || program === "bun") { const [sub, ...r] = sc.argv; if (sub !== "exec" && sub !== "dlx" && sub !== "x") return null; rest = r; }
  else if (program === "npm") { const [sub, ...r] = sc.argv; if (sub !== "exec") return null; rest = r; }
  else return null;
  const at = rest.findIndex((t) => !t.startsWith("-") || t === "--");
  if (at < 0) return null;
  const start = rest[at] === "--" ? at + 1 : at;
  return isWrangler(rest[start]) ? rest.slice(start + 1) : null;
}

const WR_VALUED = ["--env", "-e", "--config", "-c", "--name", "--command", "--file", "--project-name", "--branch", "--commit-hash", "--commit-message", "--compatibility-date", "--compatibility-flags",
  "--var", "--define", "--route", "--routes", "--outdir", "--tag", "--message", "--content-type", "--content-disposition", "--cache-control", "--expires", "--content-language", "--storage-class", "--jurisdiction", "-J",
  "--persist-to", "--database", "--binding", "--format", "--limit", "--location", "--account-id", "--production-branch", "--assets", "--site", "--cwd"];
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

const envClassOf = (env: string | undefined): string => {
  const e = (env ?? "").toLowerCase();
  if (e === "") return "unknown";
  if (/^(?:prod|production|live)$/.test(e)) return "production";
  if (/^(?:stage|staging|preprod|uat)$/.test(e)) return "staging";
  if (/^(?:dev|development|test|testing|preview|local)$/.test(e)) return "development";
  return "unknown";
};

/** A `KEY=value` assignment for `name` written before the program in the raw command. */
function inlineAssignment(raw: string, name: string): string | undefined {
  // eslint-disable-next-line security/detect-non-literal-regexp -- name is one of the callers' literal variable names (CLOUDFLARE_ACCOUNT_ID, PGHOST, PGSERVICE)
  const m = new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)'|([^\\s"']+))`).exec(raw);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
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

// ---- database ------------------------------------------------------------------------------------------------

/** What a database command is, before it is wrapped in an operation. */
export interface DatabaseFacts {
  provider: "cloudflare_d1" | "postgres" | "sqlite";
  verb: string;
  predicate_class: "bounded" | "all" | "not_applicable";
  /** A drop, a delete of every row, an ALTER that drops, or an unbounded UPDATE; `unknown` when the SQL could not be read. */
  risk: "ordinary" | "destructive" | "unknown";
  scope: "remote" | "local" | "unknown";
  /** Environment class the command itself shows. */
  environment: string;
  /** Provider-scoped name the id is keyed from. */
  databaseKey: string;
  databaseKind: string;
  /** Keyed digest input: the statement text or the migration set. Never exported. */
  digestInput?: unknown;
  migrate?: boolean;
}

const riskOf = (c: SqlClass): DatabaseFacts["risk"] => (c.destructive || (c.verb === "update" && c.predicate_class === "all") ? "destructive" : "ordinary");

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

const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1", "[::1]"]);

const PSQL_VALUED_LONG = ["--host", "--port", "--username", "--dbname", "--command", "--file", "--output", "--set", "--variable", "--pset", "--field-separator", "--record-separator", "--table-attr", "--log-file"];
const PSQL_SHORT = "hpUdcfoLvPFRT";

/** Where psql connects as far as the command says: `-h`/`--host`, a `host=` connection string or URI, an inline `PGHOST=`,
 *  or a service (`service=`, `PGSERVICE=`), which names a remote host defined elsewhere. Undefined when nothing names one. */
function psqlHost(sc: SimpleCommand): string | undefined {
  const argv = sc.argv;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "-h" || t === "--host") return argv[i + 1] ?? "";
    if (t.startsWith("--host=")) return t.slice(7);
    if (/^-h./.test(t)) return t.slice(2);
    // eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored; the optional user part cannot cross `@` or `/`, and the host repeat ends the match
    const uri = /^postgres(?:ql)?:\/\/(?:[^@/]*@)?([^:/?]+)/i.exec(t);
    if (uri) return uri[1];
    const kv = /(?:^|\s)host=([^\s]+)/.exec(t);
    if (kv) return kv[1];
    if (/(?:^|\s)service=/.test(t)) return "pg-service";
  }
  const inline = inlineAssignment(sc.raw, "PGHOST");
  if (inline !== undefined) return inline;
  if (inlineAssignment(sc.raw, "PGSERVICE") !== undefined) return "pg-service";
  return undefined;
}

function psqlFacts(sc: SimpleCommand, ctx: ReadContext): DatabaseFacts | null {
  const commands: string[] = [];
  const files: string[] = [];
  let host: string | undefined, port: string | undefined, db: string | undefined;
  const positional: string[] = [];
  const argv = sc.argv;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--") { positional.push(...argv.slice(i + 1)); break; }
    let name: string | undefined, value: string | undefined;
    if (t.startsWith("--")) {
      const at = t.indexOf("=");
      name = at > 0 ? t.slice(0, at) : t;
      value = at > 0 ? t.slice(at + 1) : PSQL_VALUED_LONG.includes(name) ? argv[++i] : undefined;
    } else if (t.startsWith("-") && t.length > 1) {
      for (let k = 1; k < t.length; k++) {
        if (PSQL_SHORT.includes(t[k])) { name = `-${t[k]}`; value = k + 1 < t.length ? t.slice(k + 1) : argv[++i]; break; }
      }
      if (name === undefined) continue;
    } else { positional.push(t); continue; }
    if (name === "-c" || name === "--command") { if (value !== undefined) commands.push(value); }
    else if (name === "-f" || name === "--file") { if (value !== undefined) files.push(value); }
    else if (name === "-h" || name === "--host") host = value;
    else if (name === "-p" || name === "--port") port = value;
    else if (name === "-d" || name === "--dbname") db = value;
  }
  if (commands.length + files.length === 0) return null;
  const texts: string[] = [...commands];
  for (const f of files) {
    if (f === "-") return null;
    const text = filesOf(ctx).readText(resolvePath(ctx.cwd, f), 5 * 1024 * 1024);
    if (text === null) return null;
    texts.push(text);
  }
  const c = classifySql(texts.join(";\n"));
  if (!c) return null;
  // The connection: a URI, a key=value string, or a database name; credentials never read further than the host.
  const target = db ?? positional[0];
  if (target && /^postgres(?:ql)?:\/\//i.test(target)) {
    try { const u = new URL(target); host ??= u.hostname; port ??= u.port; db = decodeURIComponent(u.pathname.replace(/^\//, "")); } catch { return null; }
  } else if (target && /(?:^|\s)(?:host|dbname|port|service)=/.test(target)) {
    // eslint-disable-next-line security/detect-non-literal-regexp -- k is one of the literal libpq keys (host, port, dbname, service)
    const kv = (k: string): string | undefined => new RegExp(`(?:^|\\s)${k}=([^\\s]+)`).exec(target)?.[1];
    host ??= kv("host"); port ??= kv("port"); db = kv("dbname");
    if (host === undefined && kv("service")) host = "pg-service";
  } else db = target;
  // An assignment on the command itself (`PGHOST=… psql`, `PGSERVICE=…`) sets the host for this run.
  host ??= inlineAssignment(sc.raw, "PGHOST") ?? (inlineAssignment(sc.raw, "PGSERVICE") !== undefined ? "pg-service" : undefined);
  host ??= envOf(ctx, "PGHOST") ?? "";
  port ??= envOf(ctx, "PGPORT") ?? "5432";
  db ??= envOf(ctx, "PGDATABASE") ?? "";
  const isLocal = LOCAL_HOSTS.has(host.toLowerCase());
  return {
    provider: "postgres", verb: c.verb, predicate_class: c.predicate_class, risk: riskOf(c), scope: isLocal ? "local" : "remote",
    environment: isLocal ? "development" : "unknown", databaseKey: `${host.toLowerCase()}:${port}/${db}`, databaseKind: "pg", digestInput: { sql: texts.join(";\n") },
  };
}

const SQLITE_VALUED = new Set(["-cmd", "-init", "-separator", "-newline", "-nullvalue", "-vfs", "-mmap", "-pagecache", "-lookaside", "-maxsize", "-A"]);

function sqliteFacts(sc: SimpleCommand, ctx: ReadContext): DatabaseFacts | null {
  const positional: string[] = [];
  const texts: string[] = [];
  for (let i = 0; i < sc.argv.length; i++) {
    const t = sc.argv[i];
    if (t === "-init" || t === "-vfs" || t === "-A") return null;
    if (SQLITE_VALUED.has(t)) { const v = sc.argv[++i]; if (t === "-cmd" && v !== undefined) texts.push(v); continue; }
    if (t.startsWith("-") && t.length > 1) continue;
    positional.push(t);
  }
  const [dbPath, ...sql] = positional;
  if (!dbPath || sql.length === 0) return null; // interactive, or SQL on standard input
  const c = classifySql([...texts, ...sql].join(";\n"));
  if (!c) return null;
  const key = dbPath === ":memory:" ? dbPath : resolvePath(ctx.cwd, dbPath).replace(/\\/g, "/").toLowerCase();
  return { provider: "sqlite", verb: c.verb, predicate_class: c.predicate_class, risk: riskOf(c), scope: "local", environment: dbPath === ":memory:" ? "development" : "unknown", databaseKey: key, databaseKind: "sqlite", digestInput: { sql: [...texts, ...sql].join(";\n") } };
}

/** The database facts of a simple command, or null when it is not a readable database command. */
export function databaseFacts(sc: SimpleCommand, ctx: ReadContext): DatabaseFacts | null {
  if (sc.opaque) return null;
  const program = canonProgram(sc.program);
  if (program === "psql") return psqlFacts(sc, ctx);
  if (program === "sqlite3" || program === "sqlite") return sqliteFacts(sc, ctx);
  const w = parseWrangler(sc, ctx);
  return w ? d1Facts(w, ctx) : null;
}

function databaseOperation(f: DatabaseFacts, ctx: InfraContext, request: unknown): Operation {
  const id = ctx.key.resourceId(f.databaseKind, f.databaseKey);
  return {
    type: "database", resource_id: id, ...common(ctx, request, f.environment),
    provider: f.provider, verb: f.verb, predicate_class: f.predicate_class, database_id: id, reviewed_destructive: false,
    ...(f.digestInput !== undefined && (f.migrate || f.verb !== "read") ? { migration_digest: ctx.key.requestDigest({ domain: "sql", input: f.digestInput }) } : {}),
  };
}

// ---- Cloudflare ------------------------------------------------------------------------------------------------

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

// ---- entry points -------------------------------------------------------------------------------------------------

/** The typed operation for one simple command: a Wrangler or database CLI call, or a shell fetcher. */
export function deriveInfraOperation(sc: SimpleCommand, ctx: InfraContext, request: unknown, dialect: "posix" | "powershell" = "posix", networkOnly = false): Operation | null {
  if (sc.opaque) return null;
  if (networkOnly) return networkFromCommand(sc, ctx, request, dialect);
  const facts = databaseFacts(sc, ctx);
  if (facts) return databaseOperation(facts, ctx, request);
  const w = parseWrangler(sc, ctx);
  if (w) return cloudflareFromWrangler(w, ctx, request);
  return networkFromCommand(sc, ctx, request, dialect);
}

function networkFromCommand(sc: SimpleCommand, ctx: InfraContext, request: unknown, dialect: "posix" | "powershell"): Operation | null {
  const fetch = fetchFromCommand(sc, dialect);
  if (!fetch) return null;
  const dest = parseDestination(fetch.url, true);
  return dest ? networkOperation(dest, fetch.method, fetch.hasBody, ctx, request) : null;
}

/** One remote-database action per command of a shell call that touches a remote database, for
 *  the opt-in enforcement rule. `risk` is the same classification the typed operation uses. */
export interface DatabaseGuardAction { provider: string; verb: string; scope: string; risk: string }

export function databaseGuardActions(command: string, dialect: "posix" | "powershell", ctx: ReadContext): DatabaseGuardAction[] {
  const src = dialect === "powershell" ? command.replace(/`(.)/g, "$1").replace(/\\/g, "/") : command;
  const out: DatabaseGuardAction[] = [];
  for (const sc of decomposeShell(src)) {
    if (sc.opaque) continue;
    let facts: DatabaseFacts | null;
    try { facts = databaseFacts(sc, ctx); } catch { facts = null; }
    if (facts) { if (facts.scope !== "local") out.push({ provider: facts.provider, verb: facts.verb, scope: facts.scope, risk: facts.risk }); continue; }
    // A wrangler d1 command whose SQL could not be read is not silently allowed on a remote database.
    const w = parseWrangler(sc, ctx);
    if (w && w.area === "d1" && (w.sub === "execute" || (w.sub === "migrations" && w.pos[2] === "apply")) && !w.s.flags.has("--local")) {
      out.push({ provider: "cloudflare_d1", verb: "unknown", scope: w.s.flags.has("--remote") ? "remote" : "unknown", risk: "unknown" });
    } else if (canonProgram(sc.program) === "psql") {
      const raw = sc.argv.join(" ");
      const host = psqlHost(sc);
      const remote = host !== undefined && !LOCAL_HOSTS.has(host.toLowerCase());
      // SQL the command does not show (standard input, a redirect, a here-document) sent to a host that is not this machine
      // cannot be judged: it is unknown, like unreadable -c/-f SQL.
      if (remote) out.push({ provider: "postgres", verb: "unknown", scope: "remote", risk: "unknown" });
      else if (!/(?:^|\s)(?:-h\s*|--host[= ])(?:localhost|127\.0\.0\.1)\b/.test(raw) && /\s-[a-zA-Z]*[cf]|--command|--file/.test(` ${raw}`)) out.push({ provider: "postgres", verb: "unknown", scope: "unknown", risk: "unknown" });
    }
  }
  return out;
}
