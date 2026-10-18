// What the typed infrastructure readers share: the file and environment probe, the context they derive in, and the
// database facts a database reader returns (typed-infra.ts for the generic readers, typed-wrangler.ts for Wrangler).

import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { SqlClass } from "./sql-classify.js";
import type { BindingKey } from "./observation.js";

export type Operation = Record<string, unknown>;

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

export const UNBOUND = "unbound";
export const filesOf = (ctx: ReadContext): FileProbe => ctx.files ?? systemFiles;
export const envOf = (ctx: ReadContext, name: string): string | undefined => (ctx.env ? ctx.env(name) : process.env[name]);
export const resolvePath = (cwd: string, p: string): string => (isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) ? p : join(cwd, p));

export function common(ctx: InfraContext, request: unknown, environment_class: string): Operation {
  return {
    environment_class, reference_set_version: ctx.referenceSetVersion,
    request_digest: ctx.key.requestDigest(request), digest_key_generation: ctx.key.generation,
  };
}

export const envClassOf = (env: string | undefined): string => {
  const e = (env ?? "").toLowerCase();
  if (e === "") return "unknown";
  if (/^(?:prod|production|live)$/.test(e)) return "production";
  if (/^(?:stage|staging|preprod|uat)$/.test(e)) return "staging";
  if (/^(?:dev|development|test|testing|preview|local)$/.test(e)) return "development";
  return "unknown";
};

/** A `KEY=value` assignment for `name` written before the program in the raw command. */
export function inlineAssignment(raw: string, name: string): string | undefined {
  // eslint-disable-next-line security/detect-non-literal-regexp -- name is one of the callers' literal variable names (CLOUDFLARE_ACCOUNT_ID, PGHOST, PGSERVICE)
  const m = new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)'|([^\\s"']+))`).exec(raw);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

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

export const riskOf = (c: SqlClass): DatabaseFacts["risk"] => (c.destructive || (c.verb === "update" && c.predicate_class === "all") ? "destructive" : "ordinary");
