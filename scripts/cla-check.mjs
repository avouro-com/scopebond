#!/usr/bin/env node
/**
 * cla-check.mjs — the CLA check on pull requests (see CLA.md). Self-contained: Node
 * built-ins only, no token, no network. Called from .github/workflows/cla.yml:
 *
 *   node scripts/cla-check.mjs   # reads the pull_request event at GITHUB_EVENT_PATH
 *
 * The author signs in the pull request description, either by ticking the template's
 * "I agree to the CLA" box or by including the signing sentence. Editing the
 * description re-runs the check. Maintainers (owner, members, collaborators) and the
 * dependency bots are covered already and pass.
 *
 * Exits 0 when signed or exempt, 1 when not signed (with instructions).
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SIGNING_SENTENCE = "I have read the CLA Document and I hereby sign the CLA";

const EXEMPT_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
// The event reports a private organization member as CONTRIBUTOR, so the maintainers are also named here.
export const MAINTAINERS = new Set(["avourohq"]);
const EXEMPT_BOTS = new Set(["dependabot[bot]", "github-actions[bot]"]);

/** True when the description ticks the CLA box ("- [x] I agree to the [CLA](…)") or
 *  carries the signing sentence on a line of its own (quoted or not). HTML comments are
 *  ignored, so the template's own reminder text never counts. */
export function signedIn(body) {
  const text = String(body ?? "").replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^>\s*/, "");
    if (/^[-*]\s+\[[xX]\]\s+I agree to the \[?CLA\]?(?:\([^)]*\))?\.?$/.test(line)) return true;
    if (line.replace(/\.$/, "") === SIGNING_SENTENCE) return true;
  }
  return false;
}

/** The check's verdict for one pull_request event payload. */
export function claVerdict(event) {
  const pr = event?.pull_request;
  if (!pr) return { ok: true, reason: "not a pull request" };
  const login = String(pr.user?.login ?? "");
  if (EXEMPT_BOTS.has(login)) return { ok: true, reason: `${login} is a dependency bot` };
  if (MAINTAINERS.has(login)) return { ok: true, reason: `${login} is a maintainer` };
  if (EXEMPT_ASSOCIATIONS.has(String(pr.author_association ?? ""))) return { ok: true, reason: `${login} is a maintainer (${pr.author_association})` };
  if (signedIn(pr.body)) return { ok: true, reason: `${login} signed in the pull request description` };
  return { ok: false, reason: `${login} has not signed the CLA` };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "x").href) {
  const path = process.env.GITHUB_EVENT_PATH;
  const event = path ? JSON.parse(readFileSync(path, "utf8")) : {};
  const verdict = claVerdict(event);
  if (verdict.ok) {
    console.log(`CLA: ${verdict.reason}.`);
  } else {
    console.log(`CLA: ${verdict.reason}.

To sign, edit this pull request's description and either tick the box
  - [x] I agree to the [CLA](../CLA.md).
or add this sentence on a line of its own:
  ${SIGNING_SENTENCE}

Editing the description re-runs this check. See CLA.md.`);
    process.exit(1);
  }
}
