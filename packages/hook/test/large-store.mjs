// Builds a large local store the way hook 0.20 and earlier laid it out, so the storage work can be
// measured on a realistic file: every action kept the whole policy twice (the authority row and the
// reservation) and the receipt twice (the receipts table and the lifecycle row). Seed receipts come
// from real tool calls; the rest are copies with fresh ids and timestamps spread over `days`.
//
// Run directly to build one and print its size:  node test/large-store.mjs <config-dir> <megabytes>
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const LEGACY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, intent_hash TEXT NOT NULL, policy_hash TEXT NOT NULL,
    realtime_result TEXT NOT NULL, executed INTEGER NOT NULL, timestamp TEXT NOT NULL, receipt_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS anchors (seq INTEGER PRIMARY KEY, anchor_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS authority_actions (
    action_id TEXT PRIMARY KEY, state TEXT NOT NULL, candidate_json TEXT NOT NULL,
    policy_ref_json TEXT NOT NULL, policy_snapshot TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS authority_consumptions (
    kind TEXT NOT NULL, value TEXT NOT NULL, action_id TEXT NOT NULL, PRIMARY KEY (kind, value));
  CREATE TABLE IF NOT EXISTS authority_lifecycle (
    action_id TEXT PRIMARY KEY, reservation_json TEXT NOT NULL, realtime_result TEXT,
    adapter_id TEXT, pre_receipt_json TEXT, terminal_receipt_json TEXT);
  CREATE TABLE IF NOT EXISTS gateway_stops (target TEXT PRIMARY KEY, stopped INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS receipts_timestamp ON receipts (timestamp);`;

const SEED_COMMANDS = [
  "git status", "git log --oneline -5", "ls -la", "cat README.md", "grep -rn TODO src",
  "pnpm test", "node scripts/build.mjs", "cd packages && git diff", "rm -rf ./build", "git push origin feature/x",
  "sed -n 1,40p src/index.ts", "npm run lint", "echo hello", "find . -name '*.ts'", "git commit -m wip",
];

/** Make a project whose config dir holds real keys, a real policy and a few real receipts. */
export function seedProject() {
  const dir = mkdtempSync(join(tmpdir(), "sb-large-"));
  const config = join(dir, "sb-config"); // not ".scopebond": the guard (rightly) blocks reading any folder by that name
  const env = { ...process.env, SCOPEBOND_HOOK_DIR: config };
  execFileSync(process.execPath, [cli, "init", "--no-install", "--yes"], { cwd: dir, encoding: "utf8", env });
  for (const command of SEED_COMMANDS) toolCall(config, dir, command);
  return { dir, config };
}

export function toolCall(config, cwd, command, extraArgs = []) {
  const payload = JSON.stringify({ cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
  try {
    return execFileSync(process.execPath, [...extraArgs, cli, "claude"], {
      cwd, input: payload, encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: config, SCOPEBOND_CLOUD_DISABLED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) { return error.stdout ?? ""; } // a deny exits 2; the receipt is still written
}

/** Replace `<config>/receipts.db` with a legacy-layout store of about `megabytes` MB. */
export function buildLegacyStore(config, megabytes, { days = 3, now = Date.now() } = {}) {
  const dbPath = join(config, "receipts.db");
  const seedDb = new DatabaseSync(dbPath);
  const seeds = seedDb.prepare("SELECT receipt_json FROM receipts ORDER BY id").all().map((r) => JSON.parse(r.receipt_json));
  seedDb.close();
  if (!seeds.length) throw new Error("no seed receipts were recorded");
  const policyText = readFileSync(join(config, "policy.json"), "utf8");
  const policy = JSON.stringify(JSON.parse(policyText.replace(/^\uFEFF/, "")));
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
  rmSync(join(config, "store-upkeep.json"), { force: true }); // a fresh file has had no upkeep

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;");
  db.exec(LEGACY_SCHEMA);
  const insReceipt = db.prepare("INSERT INTO receipts (intent_hash,policy_hash,realtime_result,executed,timestamp,receipt_json) VALUES (?,?,?,?,?,?)");
  const insAction = db.prepare("INSERT INTO authority_actions (action_id,state,candidate_json,policy_ref_json,policy_snapshot) VALUES (?,?,?,?,?)");
  const insUse = db.prepare("INSERT INTO authority_consumptions (kind,value,action_id) VALUES (?,?,?)");
  const insLife = db.prepare("INSERT INTO authority_lifecycle (action_id,reservation_json,realtime_result,terminal_receipt_json) VALUES (?,?,?,?)");
  const span = days * 24 * 60 * 60 * 1000;
  let written = 0;
  let rows = 0;
  const target = megabytes * 1024 * 1024;
  db.exec("BEGIN");
  while (written < target) {
    const seed = structuredClone(seeds[rows % seeds.length]);
    const id = `fixture-${rows.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const at = new Date(now - span + Math.floor((span * rows) / Math.max(1, target / 17_000))).toISOString();
    const p = seed.payload;
    p.timestamp = at;
    if (p.action_ref) p.action_ref.action_id = id;
    if (p.authorization?.agent) p.authorization.agent.request_id = id;
    const receipt = JSON.stringify(seed);
    const candidate = JSON.stringify({ intent: p.intent, action_id: id, intent_hash: p.intent_hash, executed: false, realtime_result: "allow", timestamp: at });
    const policyRef = JSON.stringify(p.policy_ref ?? { id: null, version: 1, digest: p.policy_hash });
    const context = { ...p };
    for (const outcome of ["realtime_result", "executed", "override", "execution", "execution_ref"]) delete context[outcome];
    const reservation = JSON.stringify({
      action_id: id, candidate: JSON.parse(candidate), policy_ref: JSON.parse(policyRef), policy_snapshot: policy,
      authorization_ids: { request_id: id }, receipt_context: context,
    });
    insReceipt.run(p.intent_hash, p.policy_hash, p.realtime_result, p.executed ? 1 : 0, at, receipt);
    insAction.run(id, p.execution?.state ?? "cooperative_allow", candidate, policyRef, policy);
    insUse.run("request_id", id, id);
    insLife.run(id, reservation, p.realtime_result, receipt);
    written += receipt.length * 2 + candidate.length + policy.length + reservation.length + policyRef.length + 200;
    rows++;
    if (rows % 2000 === 0) { db.exec("COMMIT"); db.exec("BEGIN"); }
  }
  db.exec("COMMIT");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();
  return { dbPath, rows, bytes: statSync(dbPath).size };
}

/** Peak memory (MB) of one hook process deciding `command`. */
export function hookPeakMb(config, cwd, command) {
  const out = join(mkdtempSync(join(tmpdir(), "sb-rss-")), "rss.txt");
  const probe = fileURLToPath(new URL("./rss-probe.mjs", import.meta.url));
  execFileSync(process.execPath, ["--import", `file:///${probe.replace(/\\/g, "/")}`, cli, "claude"], {
    cwd, input: JSON.stringify({ cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: config, SCOPEBOND_CLOUD_DISABLED: "1", SCOPEBOND_RSS_OUT: out },
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!existsSync(out)) throw new Error("the probe wrote nothing");
  return Number(readFileSync(out, "utf8")) / 1024;
}

if (/large-store.mjs$/.test(process.argv[1] ?? "")) {
  const megabytes = Number(process.argv[3] ?? 700);
  const { dir, config } = process.argv[2] && existsSync(process.argv[2]) ? { dir: process.argv[2], config: join(process.argv[2], "sb-config") } : seedProject();
  const built = buildLegacyStore(config, megabytes);
  console.log(JSON.stringify({ dir, config, ...built, mb: Math.round(built.bytes / 1048576) }));
}
