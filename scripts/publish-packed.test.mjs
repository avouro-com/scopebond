import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { checkTarballs, main, readPlan, releaseNotes } from "./publish-packed.mjs";

const integrity = (bytes) => `sha256-${createHash("sha256").update(bytes).digest("base64")}`;

/** A pack directory holding the given packages (stages of [name, version]) and a workspace with their CHANGELOGs. */
function fixture(stages) {
  const root = mkdtempSync(join(tmpdir(), "publish-packed-"));
  const pack = join(root, "pack");
  mkdirSync(join(pack, "packages"), { recursive: true });
  const plan = stages.map((stage) => stage.map(([name, version]) => {
    const short = name.split("/")[1];
    const bytes = Buffer.from(`tarball ${name}@${version}`);
    writeFileSync(join(pack, "packages", `scopebond-${short}-${version}.tgz`), bytes);
    mkdirSync(join(root, "packages", short), { recursive: true });
    writeFileSync(join(root, "packages", short, "package.json"), JSON.stringify({ name, version }));
    writeFileSync(join(root, "packages", short, "CHANGELOG.md"), `# ${name}\n\n## ${version}\n\n### Patch Changes\n\n- fixed ${short}\n\n## 0.0.1\n\n- old\n`);
    return { kind: "publish", name, version, access: "public", tag: "latest", tarball: { path: `packages/scopebond-${short}-${version}.tgz`, integrity: integrity(bytes) } };
  }));
  writeFileSync(join(pack, "publish-plan.json"), JSON.stringify({ version: 1, plan }));
  return { root, pack };
}

/** Stub npm and gh on PATH that record their calls; `gh release view` fails (no release yet) unless listed in `existing`. */
function stubs(root, existing = []) {
  const bin = join(root, "bin");
  const log = join(root, "calls.jsonl");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "stub.mjs"), `
    import { appendFileSync } from "node:fs";
    const [program, ...args] = process.argv.slice(2);
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ program, args }) + "\\n");
    if (program === "gh" && args[0] === "release" && args[1] === "view") process.exit(${JSON.stringify(existing)}.includes(args[2]) ? 0 : 1);
  `);
  for (const program of ["npm", "gh"]) {
    writeFileSync(join(bin, program), `#!/bin/sh\nexec node "${join(bin, "stub.mjs").replace(/\\/g, "/")}" ${program} "$@"\n`, { mode: 0o755 });
    writeFileSync(join(bin, `${program}.cmd`), `@node "${join(bin, "stub.mjs")}" ${program} %*\r\n`);
  }
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  return () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
}

/** A registry that has exactly the listed name@version entries. */
const registry = (have) => async (url) => {
  const [, name, version] = /\/(@scopebond%2f[^/]+)\/([^/]+)$/.exec(url) ?? [];
  return new Response("{}", { status: have.includes(`${decodeURIComponent(name)}@${decodeURIComponent(version)}`) ? 200 : 404 });
};
const SHA = "a".repeat(40);

test("the plan is refused when a tarball path leaves the pack directory, a name is foreign, or a package repeats", () => {
  const { pack } = fixture([[["@scopebond/hook", "1.0.0"]]]);
  const plan = JSON.parse(readFileSync(join(pack, "publish-plan.json"), "utf8"));
  const write = (edit) => { const copy = structuredClone(plan); edit(copy.plan[0][0], copy); writeFileSync(join(pack, "publish-plan.json"), JSON.stringify(copy)); };
  write((item) => { item.tarball.path = "../../etc/x.tgz"; });
  assert.throws(() => readPlan(pack), /outside the pack directory/);
  write((item) => { item.name = "left-pad"; });
  assert.throws(() => readPlan(pack), /not a @scopebond package name/);
  write((item, copy) => { copy.plan.push([{ ...item }]); });
  assert.throws(() => readPlan(pack), /appears twice/);
  write((item) => { item.access = "restricted"; });
  assert.throws(() => readPlan(pack), /access must be public/);
});

test("a tarball that does not match its integrity publishes nothing", async () => {
  const { root, pack } = fixture([[["@scopebond/verify", "1.0.1"]], [["@scopebond/hook", "1.0.2"]]]);
  writeFileSync(join(pack, "packages", "scopebond-hook-1.0.2.tgz"), "tampered");
  assert.throws(() => checkTarballs(readPlan(pack)), /integrity does not match/);
  const calls = stubs(root);
  await assert.rejects(main({ packDir: pack, root, sha: SHA, output: join(root, "out"), fetchImpl: registry([]) }), /integrity/);
  assert.deepEqual(calls(), [], "neither npm nor gh ran");
});

test("publishes the missing versions in stage order with provenance and no scripts, skips those on npm, and releases each", async () => {
  const { root, pack } = fixture([[["@scopebond/verify", "1.0.1"]], [["@scopebond/gateway", "2.0.0"], ["@scopebond/hook", "1.0.2"]]]);
  const calls = stubs(root, ["@scopebond/verify@1.0.1"]);
  const out = join(root, "out");
  const published = await main({ packDir: pack, root, sha: SHA, output: out, fetchImpl: registry(["@scopebond/verify@1.0.1"]) });
  assert.deepEqual(published.map((p) => p.name), ["@scopebond/gateway", "@scopebond/hook"]);
  const npm = calls().filter((c) => c.program === "npm");
  assert.deepEqual(npm.map((c) => c.args[1].replace(/\\/g, "/").split("/").pop()), ["scopebond-gateway-2.0.0.tgz", "scopebond-hook-1.0.2.tgz"]);
  for (const c of npm) {
    assert.equal(c.args[0], "publish");
    for (const flag of ["--provenance", "--ignore-scripts", "--access"]) assert.ok(c.args.includes(flag), `${flag} in ${c.args.join(" ")}`);
  }
  const created = calls().filter((c) => c.program === "gh" && c.args[1] === "create");
  assert.deepEqual(created.map((c) => c.args[2]), ["@scopebond/gateway@2.0.0", "@scopebond/hook@1.0.2"], "verify's release already exists");
  for (const c of created) assert.equal(c.args[c.args.indexOf("--target") + 1], SHA);
  const notes = created[1].args[created[1].args.indexOf("--notes-file") + 1];
  assert.match(readFileSync(notes, "utf8"), /^### Patch Changes\n\n- fixed hook\n$/);
  const output = readFileSync(out, "utf8");
  assert.match(output, /^published=true$/m);
  assert.deepEqual(JSON.parse(/^published-packages=(.*)$/m.exec(output)[1]), [{ name: "@scopebond/gateway", version: "2.0.0" }, { name: "@scopebond/hook", version: "1.0.2" }]);
});

test("a re-run after a failure between publishing and tagging creates the missing releases and publishes nothing", async () => {
  const { root, pack } = fixture([[["@scopebond/agent", "0.9.0"]]]);
  const calls = stubs(root);
  const out = join(root, "out");
  const published = await main({ packDir: pack, root, sha: SHA, output: out, fetchImpl: registry(["@scopebond/agent@0.9.0"]) });
  assert.deepEqual(published, []);
  assert.deepEqual(calls().filter((c) => c.program === "npm"), []);
  assert.deepEqual(calls().filter((c) => c.args[1] === "create").map((c) => c.args[2]), ["@scopebond/agent@0.9.0"]);
  assert.match(readFileSync(out, "utf8"), /^published=false\npublished-packages=\[\]$/m);
});

test("a dry run checks everything and runs neither npm nor gh", async () => {
  const { root, pack } = fixture([[["@scopebond/mcp", "3.0.0"]]]);
  const calls = stubs(root);
  const published = await main({ packDir: pack, root, dryRun: true, sha: SHA, output: join(root, "out"), fetchImpl: registry([]) });
  assert.deepEqual(published.map((p) => p.name), ["@scopebond/mcp"]);
  assert.deepEqual(calls(), []);
});

test("a registry that cannot be read stops the release", async () => {
  const { root, pack } = fixture([[["@scopebond/hook", "1.0.3"]]]);
  const calls = stubs(root);
  await assert.rejects(main({ packDir: pack, root, sha: SHA, fetchImpl: async () => new Response("", { status: 503 }) }), /answered 503/);
  assert.deepEqual(calls(), []);
});

test("release notes are the version's own CHANGELOG section", () => {
  const changelog = "# x\n\n## 1.2.0\n\n### Minor Changes\n\n- a\n\n## 1.1.0\n\n- b\n";
  assert.equal(releaseNotes(changelog, "1.2.0"), "### Minor Changes\n\n- a");
  assert.equal(releaseNotes(changelog, "1.1.0"), "- b");
  assert.equal(releaseNotes(changelog, "9.9.9"), "Release 9.9.9.");
});
