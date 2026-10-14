#!/usr/bin/env node
// Checks npm trusted publishing (OIDC) for the packages this release will publish, before the release job publishes
// anything.
//
// npm publish tries the OIDC token exchange first and, when the registry refuses it, logs the reason only at verbose
// level and carries on without credentials. The registry then answers the unauthenticated PUT with "E404 Not Found",
// which hides the real cause. This script makes the same exchange npm makes (GitHub ID token with the audience
// `npm:registry.npmjs.org`, POSTed to the package's exchange endpoint) and, when it fails, prints the registry's own
// message beside the claims the trusted publisher is matched against (repository, workflow, environment).
//
// Only packages whose local version is not on npm yet (the ones this release publishes) are checked; the others are
// logged as skipped, so a package outside this release cannot block it.
//
// It prints no token: the ID token and any exchanged token are masked before anything is printed and then discarded.
// It never publishes. Runs only in GitHub Actions with `id-token: write`. Exit code 1 when any package would be refused.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REGISTRY = "https://registry.npmjs.org";
const AUDIENCE = `npm:${new URL(REGISTRY).hostname}`;
const TIMEOUT_MS = 15_000;
const SCOPED = /^@scopebond\/([a-z0-9][a-z0-9._-]*)$/;

const mask = (value) => {
  if (value) process.stdout.write(`::add-mask::${value}\n`);
};

/** npm's escaped form of a package name for a registry path (`@scope%2fname`, or the plain name). */
const escapeName = (name) => (name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name));

/** Public (non-private) packages under packages/, with their local versions. */
function publicPackages(root) {
  const dir = join(root, "packages");
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(dir, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!manifest.private && manifest.name && manifest.version) found.push({ name: manifest.name, version: manifest.version });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether name@version is already on npm (a public, unauthenticated read). */
async function isPublished({ name, version }) {
  const response = await fetch(`${REGISTRY}/${escapeName(name)}/${encodeURIComponent(version)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`the registry answered HTTP ${response.status} for ${name}@${version}`);
  return true;
}

/** The non-secret claims of a JWT payload that npm's trusted publisher is matched against. */
function claimsOf(jwt) {
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
  const keys = ["sub", "repository", "repository_owner", "workflow_ref", "job_workflow_ref", "environment", "ref", "event_name"];
  return Object.fromEntries(keys.map((key) => [key, payload[key] ?? "(absent)"]));
}

async function main() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    console.error("::error::No GitHub OIDC token is available: the job needs `permissions: id-token: write`.");
    return 1;
  }
  mask(requestToken);

  const toPublish = [];
  for (const pkg of publicPackages(process.cwd())) {
    if (await isPublished(pkg)) console.log(`skip  ${pkg.name}@${pkg.version}: already on npm, not part of this release`);
    else toPublish.push(pkg);
  }
  if (toPublish.length === 0) {
    console.log("No package version is missing from npm: nothing to check.");
    return 0;
  }

  const url = new URL(requestUrl);
  url.searchParams.append("audience", AUDIENCE);
  const idResponse = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${requestToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!idResponse.ok) {
    console.error(`::error::GitHub refused the OIDC token request (HTTP ${idResponse.status}).`);
    return 1;
  }
  const idToken = (await idResponse.json()).value;
  if (!idToken) {
    console.error("::error::GitHub returned no OIDC token.");
    return 1;
  }
  mask(idToken);

  const claims = claimsOf(idToken);
  console.log("OIDC claims npm matches the trusted publisher against:");
  for (const [key, value] of Object.entries(claims)) console.log(`  ${key}: ${value}`);
  if (claims.environment === "(absent)") {
    console.log("::warning::The OIDC token names no environment; a trusted publisher that names one will not match.");
  }

  const failures = [];
  for (const { name, version } of toPublish) {
    // Only this repository's scope is published from here.
    const match = SCOPED.exec(name);
    if (!match) {
      failures.push(name);
      console.log(`FAIL  ${name}: not an @scopebond package name`);
      continue;
    }
    const escaped = `@scopebond%2f${encodeURIComponent(match[1])}`;
    const response = await fetch(`${REGISTRY}/-/npm/v1/oidc/token/exchange/package/${escaped}`, {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Bearer ${idToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.token) {
      mask(body.token);
      console.log(`ok    ${name}@${version}: npm accepts this job as its trusted publisher`);
    } else {
      const message = typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : "no message";
      failures.push(name);
      console.log(`FAIL  ${name}@${version}: HTTP ${response.status}: ${message}`);
    }
  }

  if (failures.length > 0) {
    console.error(
      `::error::npm refused trusted publishing for ${failures.join(", ")}. On npmjs.com, each package's Trusted Publisher ` +
        `must name GitHub Actions, organization and repository ${claims.repository}, workflow filename release.yml, and ` +
        `environment ${claims.environment} (the claims above). Nothing was published.`,
    );
    return 1;
  }
  return 0;
}

process.exitCode = await main();
