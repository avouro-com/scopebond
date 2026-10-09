#!/usr/bin/env node
/**
 * sarif-drop-suppressed.mjs — remove suppressed results from a SARIF file before it is
 * uploaded to code scanning. Node built-ins only.
 *
 *   node scripts/sarif-drop-suppressed.mjs eslint.sarif
 *
 * An in-source disable (`// eslint-disable-next-line <rule> -- <reason>`) keeps its reason
 * beside the code. The SARIF formatter still emits the result, marked with a suppression,
 * and code scanning opens it as an alert anyway: it does not honour SARIF suppressions.
 * Leaving those results out keeps the alert list to findings nobody has decided on yet.
 * The file is rewritten in place; the count removed is printed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The SARIF log without results that carry a suppression; `removed` counts them. */
export function dropSuppressed(log) {
  let removed = 0;
  for (const run of log?.runs ?? []) {
    if (!Array.isArray(run.results)) continue;
    const kept = run.results.filter((result) => !(Array.isArray(result.suppressions) && result.suppressions.length > 0));
    removed += run.results.length - kept.length;
    run.results = kept;
  }
  return { log, removed };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "x").href) {
  const file = process.argv[2];
  if (!file) { console.error("usage: sarif-drop-suppressed.mjs <file.sarif>"); process.exit(2); }
  const { log, removed } = dropSuppressed(JSON.parse(readFileSync(file, "utf8")));
  writeFileSync(file, JSON.stringify(log));
  console.log(`sarif-drop-suppressed: ${removed} suppressed result(s) left out of ${file}`);
}
