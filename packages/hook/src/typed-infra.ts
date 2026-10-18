// Typed `network` and `database` operations, derived from the ACTUAL command line or tool input before it runs.
//
// Same rules as typed-ops.ts: a fact that cannot be read from the request stays unknown or
// leaves no operation at all, and nothing raw is exported. What each operation carries:
//
//   network      scheme, lowercase IDNA host, effective port, method and read/write/upload. Never
//                the path, query, credentials, headers or body. A redirect hop is not followed
//                or bound (`redirect_binding` is always omitted), so a redirected request is
//                not qualified against the origin's approval.
//   database     provider, verb, predicate class and a keyed digest of the statement or the
//                local migration set. Never SQL text, table or column names, or rows. A
//                statement the classifier cannot place leaves no operation (the closed
//                schema has no "unknown" verb). Read from psql and sqlite3 here, and from
//                Wrangler's D1 commands in typed-wrangler.ts.

import { canonProgram, decomposeShell, type SimpleCommand } from "./shell.js";
import { classifySql } from "./sql-classify.js";
import { common, envOf, filesOf, inlineAssignment, resolvePath, riskOf, type DatabaseFacts, type InfraContext, type Operation, type ReadContext } from "./infra-probe.js";
import { wranglerDatabaseFacts, wranglerOperation, wranglerUnreadableD1 } from "./typed-wrangler.js";
export { systemFiles, fixtureFiles } from "./infra-probe.js";
export type { FileProbe, InfraContext, ReadContext, DatabaseFacts } from "./infra-probe.js";

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

// ---- database ------------------------------------------------------------------------------------------------

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
  return wranglerDatabaseFacts(sc, ctx);
}

function databaseOperation(f: DatabaseFacts, ctx: InfraContext, request: unknown): Operation {
  const id = ctx.key.resourceId(f.databaseKind, f.databaseKey);
  return {
    type: "database", resource_id: id, ...common(ctx, request, f.environment),
    provider: f.provider, verb: f.verb, predicate_class: f.predicate_class, database_id: id, reviewed_destructive: false,
    ...(f.digestInput !== undefined && (f.migrate || f.verb !== "read") ? { migration_digest: ctx.key.requestDigest({ domain: "sql", input: f.digestInput }) } : {}),
  };
}

// ---- entry points -------------------------------------------------------------------------------------------------

/** The typed operation for one simple command: a database CLI call (psql, sqlite3, Wrangler's D1), a Wrangler change, or a
 *  shell fetcher. */
export function deriveInfraOperation(sc: SimpleCommand, ctx: InfraContext, request: unknown, dialect: "posix" | "powershell" = "posix", networkOnly = false): Operation | null {
  if (sc.opaque) return null;
  if (networkOnly) return networkFromCommand(sc, ctx, request, dialect);
  const facts = databaseFacts(sc, ctx);
  if (facts) return databaseOperation(facts, ctx, request);
  const cloudflare = wranglerOperation(sc, ctx, request);
  if (cloudflare !== undefined) return cloudflare;
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
    const d1 = wranglerUnreadableD1(sc, ctx);
    if (d1) out.push(d1);
    else if (canonProgram(sc.program) === "psql") {
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
