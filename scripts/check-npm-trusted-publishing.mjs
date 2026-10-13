#!/usr/bin/env node
// Checks npm trusted publishing (OIDC) for every public workspace package before the release job publishes anything.
//
// npm publish tries the OIDC token exchange first and, when the registry refuses it, logs the reason only at verbose
// level and carries on without credentials. The registry then answers the unauthenticated PUT with "E404 Not Found",
// which hides the real cause. This script makes the same exchange npm makes (GitHub ID token with the audience
// `npm:registry.npmjs.org`, POSTed to the package's exchange endpoint) and, when it fails, prints the registry's own
// message beside the claims the trusted publisher is matched against (repository, workflow, environment).
//
// It prints no token: the ID token and any exchanged token are masked and discarded. It never publishes.
// Runs only in GitHub Actions with `id-token: write`. Exit code 1 when any package would be refused.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REGISTRY = "https://registry.npmjs.org";
const AUDIENCE = `npm:${new URL(REGISTRY).hostname}`;

const mask = (value) => {
  if (value) process.stdout.write(`::add-mask::${value}\n`);
};

/** Public (non-private) packages under packages/, by name. */
function publicPackages(root) {
  const dir = join(root, "packages");
  const names = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(dir, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!manifest.private && manifest.name) names.push(manifest.name);
  }
  return names.sort();
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

  const url = new URL(requestUrl);
  url.searchParams.append("audience", AUDIENCE);
  const idResponse = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${requestToken}` } });
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
  for (const name of publicPackages(process.cwd())) {
    const escaped = name.replace("/", "%2f");
    const response = await fetch(`${REGISTRY}/-/npm/v1/oidc/token/exchange/package/${escaped}`, {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Bearer ${idToken}` },
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.token) {
      mask(body.token);
      console.log(`ok    ${name}: npm accepts this job as its trusted publisher`);
    } else {
      const message = typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : "no message";
      failures.push(name);
      console.log(`FAIL  ${name}: HTTP ${response.status}: ${message}`);
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
