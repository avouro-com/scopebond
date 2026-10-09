// A conservative SQL classifier for the typed `database` operation.
//
// It reads a statement only to decide its verb and whether an UPDATE or DELETE names a
// selective predicate. Its result is two closed values; the text, the table names, the
// column names, the literals and the rows never leave this function. It is a classifier for
// a coding agent's own command line, not a parser: a statement it cannot place with
// confidence makes the whole input `null` (the caller then records no database operation and
// the command stays a plain shell action), and an UPDATE or DELETE whose predicate it cannot
// show to be selective is reported as covering `all` rows. Unknown is never reported clean.
//
// Known limits, on purpose: a function call inside a SELECT can have effects (`SELECT
// pg_terminate_backend(...)`), dynamic SQL and procedural blocks are not read, and a predicate
// that is selective in form but matches every row at run time (`WHERE id > -1`) is bounded.

export type SqlVerb = "read" | "insert" | "update" | "delete" | "delete_all" | "create" | "alter" | "drop";
export interface SqlClass {
  verb: SqlVerb;
  /** The broadest predicate among the UPDATE and DELETE statements, `not_applicable` when there are none. */
  predicate_class: "bounded" | "all" | "not_applicable";
  /** Any statement that removes data or structure: drop, delete_all (a truncate too), or an ALTER that drops or renames. */
  destructive: boolean;
}

const MAX_SQL = 1_000_000;
const SEVERITY: Record<SqlVerb, number> = { read: 0, insert: 1, create: 2, update: 3, delete: 4, alter: 5, delete_all: 6, drop: 7 };

/** Comments removed, string literals reduced to `'s'` (or kept as `'%'` when only wildcards), quoted identifiers reduced to
 *  the opaque token `ident_` (a quoted name is never read as a keyword). Null when a quote or comment is left open, a
 *  dollar-quoted body is present, a block comment nests (PostgreSQL nests them; SQLite does not, so the two read the text
 *  differently), a literal holds a backslash (`E'…'` escapes), or a backslash stands outside a literal (a psql meta-command). */
function clean(text: string): string | null {
  let out = "";
  for (let i = 0; i < text.length;) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "-" && next === "-") { const e = text.indexOf("\n", i); i = e < 0 ? text.length : e; out += " "; continue; }
    if (c === "/" && next === "*") {
      const e = text.indexOf("*/", i + 2);
      if (e < 0 || text.slice(i + 2, e).includes("/*")) return null;
      i = e + 2; out += " "; continue;
    }
    if (c === "\\") return null;
    if (c === "'") {
      let j = i + 1;
      let body = "";
      for (;;) {
        if (j >= text.length) return null;
        if (text[j] === "'" && text[j + 1] === "'") { body += "'"; j += 2; continue; }
        if (text[j] === "'") break;
        if (text[j] === "\\") return null;
        body += text[j++];
      }
      out += /^[%_]+$/.test(body) ? `'${body}'` : "'s'";
      i = j + 1;
      continue;
    }
    if (c === '"' || c === "`") {
      const e = text.indexOf(c, i + 1);
      if (e < 0) return null;
      out += " ident_ ";
      i = e + 1;
      continue;
    }
    if (c === "[" && /^\[[A-Za-z0-9_ ]+\]/.test(text.slice(i))) { const e = text.indexOf("]", i); out += " ident_ "; i = e + 1; continue; }
    if (c === "$" && (next === "$" || /[A-Za-z_]/.test(next ?? ""))) return null; // dollar-quoted body
    out += c;
    i++;
  }
  return out;
}

/** Split on `;` outside parentheses. */
function statements(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of text) {
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    if (c === ";" && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

/** Split `text` at a top-level (depth 0) whole-word keyword; returns the parts. */
function splitTop(text: string, word: string): string[] {
  const parts: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-regexp -- word is one of this module's literal keywords (or, and, where)
  const re = new RegExp(`^${word}(?![A-Za-z0-9_])`, "i");
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (i === 0 || /[^A-Za-z0-9_]/.test(text[i - 1])) && re.test(text.slice(i))) {
      parts.push(text.slice(last, i));
      last = i + word.length;
      i = last - 1;
    }
  }
  parts.push(text.slice(last));
  return parts;
}

// eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored alternatives, each a single repeat
const LITERAL = /^(?:'[^']*'|-?\d+(?:\.\d+)?|true|false|null)$/i;

function stripParens(s: string): string {
  let t = s.trim();
  while (t.startsWith("(") && t.endsWith(")")) {
    let depth = 0;
    let closesAtEnd = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "(") depth++;
      else if (t[i] === ")") { depth--; if (depth === 0 && i < t.length - 1) { closesAtEnd = false; break; } }
    }
    if (!closesAtEnd) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

/** Whether one AND-ed condition narrows the rows: a comparison, IN, EXISTS or IS NULL that is
 *  neither a tautology nor a bare `IS NOT NULL`. */
function selective(raw: string): boolean {
  const c = stripParens(raw).replace(/\s+/g, " ");
  if (c === "") return false;
  if (splitTop(c, "or").length > 1) return false;
  if (splitTop(c, "and").length > 1) return splitTop(c, "and").some((p) => selective(p));
  if (/^(?:true|1|not false|not 0)$/i.test(c)) return false;
  if (/\bis not null$/i.test(c)) return false;
  if (/between_r$/i.test(c)) return true;
  if (/^(?:not )?exists\b/i.test(c) || /\bis null$/i.test(c)) return true;
  const m = /^(.+?) ?(==|=|<>|!=|<=|>=|<|>|\bnot like\b|\bnot ilike\b|\blike\b|\bilike\b|\bnot in\b|\bin\b|\bbetween_r\b|\bis not\b|\bis\b) ?(.+)$/i.exec(c);
  if (!m) return false;
  const left = m[1].trim();
  const right = m[3].trim();
  if (LITERAL.test(left) && LITERAL.test(right)) return false;
  if (left.toLowerCase() === right.toLowerCase()) return false;
  if (/like$/i.test(m[2]) && /^'[%_]+'$/.test(right)) return false;
  return true;
}

/** The predicate of an UPDATE or DELETE, `bounded` only when a top-level AND-ed condition is selective. */
function predicateOf(stmt: string): "bounded" | "all" {
  const parts = splitTop(stmt, "where");
  if (parts.length < 2) return "all";
  let where = parts.slice(1).join(" ");
  where = where.replace(/\b(?:returning|order by|limit)\b[\s\S]*$/i, "");
  where = where.replace(/\bbetween\s+\S+\s+and\s+\S+/gi, "between_r");
  if (splitTop(where, "or").length > 1) return "all";
  return splitTop(where, "and").some((p) => selective(p)) ? "bounded" : "all";
}

const NEUTRAL = new Set(["BEGIN", "COMMIT", "ROLLBACK", "END", "SAVEPOINT", "RELEASE", "START"]);
const DOT_READ = new Set([".schema", ".tables", ".dump", ".indexes", ".databases", ".headers", ".mode", ".timer", ".help", ".quit", ".exit", ".show", ".width", ".nullvalue", ".separator"]);

interface One { verb: SqlVerb; predicate: "bounded" | "all" | "not_applicable"; destructive?: boolean }

function one(stmt: string): One | "neutral" | null {
  const s = stmt.trim();
  if (s.startsWith(".")) {
    const word = s.split(/\s+/)[0].toLowerCase();
    return DOT_READ.has(word) ? { verb: "read", predicate: "not_applicable" } : null;
  }
  const first = /^[A-Za-z]+/.exec(s)?.[0].toUpperCase() ?? "";
  if (NEUTRAL.has(first)) return "neutral";
  switch (first) {
    case "SELECT": return /\binto\b/i.test(s) ? { verb: "create", predicate: "not_applicable" } : { verb: "read", predicate: "not_applicable" };
    case "SHOW": case "DESCRIBE": case "DESC": return { verb: "read", predicate: "not_applicable" };
    // `PRAGMA name = value` and `PRAGMA name(value)` change settings; only the bare form reads.
    case "PRAGMA": return s.includes("=") || s.includes("(") ? null : { verb: "read", predicate: "not_applicable" };
    case "EXPLAIN": {
      // eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored; each repeated option starts with its own fixed word and ends in blanks no option starts with
      const rest = s.replace(/^explain\s+(?:analyze\s+|verbose\s+|query\s+plan\s+)*(?:\([^)]*\)\s*)?/i, "");
      return rest === s || rest === "" ? null : one(rest);
    }
    case "WITH": return /\b(?:insert|update|delete|merge)\b/i.test(s) ? null
      : /\binto\b/i.test(s) ? { verb: "create", predicate: "not_applicable" } : { verb: "read", predicate: "not_applicable" };
    case "INSERT": case "REPLACE": return { verb: "insert", predicate: "not_applicable" };
    case "UPDATE": return { verb: "update", predicate: predicateOf(s) };
    case "DELETE": { const p = predicateOf(s); return { verb: p === "all" ? "delete_all" : "delete", predicate: p }; }
    case "TRUNCATE": return { verb: "delete_all", predicate: "all" };
    case "CREATE": return { verb: "create", predicate: "not_applicable" };
    case "ALTER": return { verb: "alter", predicate: "not_applicable", destructive: /\b(?:drop|rename)\b/i.test(s) };
    case "DROP": return { verb: "drop", predicate: "not_applicable" };
    default: return null;
  }
}

/** Classify SQL text, or null when any statement cannot be placed. */
export function classifySql(text: string): SqlClass | null {
  if (text.length > MAX_SQL) return null;
  const cleaned = clean(text);
  if (cleaned === null) return null;
  let verb: SqlVerb = "read";
  let sawStatement = false;
  let broadest: "bounded" | "all" | "not_applicable" = "not_applicable";
  let destructive = false;
  for (const stmt of statements(cleaned)) {
    const r = one(stmt);
    if (r === null) return null;
    if (r === "neutral") continue;
    sawStatement = true;
    if (SEVERITY[r.verb] > SEVERITY[verb]) verb = r.verb;
    if (r.predicate === "all") broadest = "all";
    else if (r.predicate === "bounded" && broadest !== "all") broadest = "bounded";
    if (r.verb === "drop" || r.verb === "delete_all" || r.destructive === true) destructive = true;
  }
  if (!sawStatement) return null;
  return { verb, predicate_class: verb === "delete_all" ? "all" : broadest, destructive };
}
