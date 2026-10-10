#!/usr/bin/env node
// One-off: remove internal tracker ids (SB…, D…, F-…, E-…) from comments in packages/*/src. They point at a private
// backlog that readers of this repository cannot see. Only comment text changes; code and strings are untouched.
//
//   node scripts/strip-ticket-ids.mjs           rewrite the files
//   node scripts/strip-ticket-ids.mjs --check   list what would change and exit non-zero if anything would
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ID = String.raw`(?:SB\d{2,3}|D\d{1,3}|F-\d{3,4}|E-\d{3,4})(?:\s*\(\d+\))?`;
// "(SB123, D45)", "(D45 (2))", "(F-1234)" when the parentheses hold nothing else.
const ONLY_IDS = new RegExp(String.raw`\s*\(\s*${ID}(?:\s*[,;/]\s*${ID})*\s*\)`, "g");
// A comment that starts with "SB123:" or "D45 (2):" (with or without a list).
const LEADING = new RegExp(String.raw`^${ID}(?:\s*[,/]\s*${ID})*\s*[:—-]\s*`);
// Whatever is left: "per D45", "SB123/SB124", "see D45": drop the id and tidy the spacing.
const ANY = new RegExp(String.raw`(?:\b(?:per|see|from|as in|under)\s+)?\b${ID}(?:\s*[,/]\s*${ID})*`, "g");

// "(D45: shape and colour)" keeps its explanation; "(D45 §4.1)" points into a private document and goes.
const ID_COLON = new RegExp(String.raw`\(\s*${ID}\s*:\s*`, "g");
const ID_SECTION = new RegExp(String.raw`\s*\(\s*${ID}\s*§[\d.]+\s*\)`, "g");
const HAS_ID = new RegExp(String.raw`\b${ID}`);

function stripComment(text) {
  if (!HAS_ID.test(text)) return text;
  // Keep the indentation and the comment marker exactly; tidy only the text after them.
  const [, lead, body] = text.match(/^(\s*(?:\/\/+|\/\*\*?|\*)?\s?)([\s\S]*)$/);
  const cleaned = body.replace(ID_COLON, "(").replace(ID_SECTION, "").replace(ONLY_IDS, "").replace(LEADING, "").replace(ANY, "").replace(/\(\s*\)/g, "")
    .replace(/(\S) {2,}/g, "$1 ").replace(/ +([.,;:)])/g, "$1").replace(/\( +/g, "(").replace(/^[,;:]\s*/, "").replace(/\s+$/, "");
  return lead + cleaned.replace(/^[a-z]/, (c) => (lead.trim() && /^[A-Z]/.test(body.replace(/^\s+/, "")) ? c.toUpperCase() : c));
}

function rewrite(source) {
  const lines = source.split("\n");
  let inBlock = false;
  return lines.map((line) => {
    if (inBlock || /^\s*\/\*/.test(line)) {
      if (line.includes("*/")) inBlock = false; else inBlock = true;
      return /^\s*(\/\*|\*)/.test(line) ? stripComment(line) : line;
    }
    if (/^\s*\/\//.test(line)) return stripComment(line);
    // A trailing comment after code: change only the comment part (skip lines with a string that holds "//").
    const at = line.indexOf(" // ");
    if (at > 0 && !/["'`][^"'`]*\/\/[^"'`]*["'`]/.test(line.slice(0, at + 4))) return line.slice(0, at) + stripComment(line.slice(at));
    return line;
  }).join("\n");
}

const files = [];
const walk = (dir) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx|mts|cts|mjs|js)$/.test(n)) files.push(p); } };
for (const pkg of readdirSync("packages")) { try { walk(join("packages", pkg, "src")); } catch { /* no src */ } }
const check = process.argv.includes("--check");
let changed = 0;
for (const f of files) {
  const before = readFileSync(f, "utf8");
  const after = rewrite(before);
  if (after === before) continue;
  changed += 1;
  if (check) console.log(f); else writeFileSync(f, after);
}
console.log(`strip-ticket-ids: ${changed} file(s) ${check ? "would change" : "changed"}`);
if (check && changed) process.exitCode = 1;
