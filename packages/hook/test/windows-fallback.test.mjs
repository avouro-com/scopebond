// The quoted Windows fallback (a folder with no short name) is reported and hardened; hook groups other tools share keep
// their hooks on uninstall; and `flush`'s edge cases (a failed attempt with nothing left, a date when the window closes on
// another day).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  refuseUnsafeQuotedPaths, isQuotedWindowsHookCommand, quotedEntryNote, configuredHookCommands, removeHarnessConfig, harnessHookIsOurs,
  nativeHookCommand, shellPlainWindowsPath, windowsShortPath, flushOutcome, clockTime,
} from "../dist/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "sb-winfallback-"));
const QUOTED = `"C:\\Program Files\\nodejs\\node.exe" "D:\\a b\\hook\\dist\\cli.js" codex`;
const PLAIN = "C:/PROGRA~1/nodejs/node.exe D:/x/hook/dist/cli.js codex";

test("a quoted path a shell expands even inside quotes is refused with a clear error", () => {
  for (const bad of ["D:\\a$b\\cli.js", "D:\\a`b\\cli.js", "D:\\100%\\cli.js", "D:\\wow!\\cli.js"]) {
    assert.throws(() => refuseUnsafeQuotedPaths(["C:\\nodejs\\node.exe", bad]), /expands .* even inside quotes.*no \$, backtick, % or !/, bad);
  }
  assert.doesNotThrow(() => refuseUnsafeQuotedPaths(["C:\\Program Files\\nodejs\\node.exe", "D:\\a b (x)\\cli.js"]));
});

test("the single executable's entry refuses such a path when it has no plain spelling (Windows)", { skip: process.platform !== "win32" && "Windows only" }, () => {
  assert.throws(() => nativeHookCommand("codex", "D:\\a b\\$x\\scopebond-agent.exe", () => null), /even inside quotes/);
  assert.equal(nativeHookCommand("codex", "D:\\a b\\x\\scopebond-agent.exe", () => null), `"D:\\a b\\x\\scopebond-agent.exe" hook codex`);
});

test("a quoted Windows entry is told apart from the plain one", () => {
  assert.equal(isQuotedWindowsHookCommand(QUOTED), true);
  assert.equal(isQuotedWindowsHookCommand(`"C:/x/scopebond-agent.exe" hook cursor`), true);
  assert.equal(isQuotedWindowsHookCommand(PLAIN), false);
  assert.equal(isQuotedWindowsHookCommand(`"/usr/bin/node" "/opt/cli.js" codex`), false);
  assert.equal(isQuotedWindowsHookCommand("npx -y @scopebond/hook@1.0.0 codex"), false);
});

test("status and doctor note a quoted Codex or Cursor entry on Windows: it may not start under PowerShell", () => {
  const dir = tmp();
  try {
    const codex = join(dir, "codex.json");
    writeFileSync(codex, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: QUOTED, commandWindows: QUOTED }] }] } }));
    assert.match(quotedEntryNote("codex", [null, undefined, codex], "win32"), /may not start under PowerShell/);
    assert.equal(quotedEntryNote("codex", [codex], "linux"), null, "only on Windows");
    assert.equal(quotedEntryNote("claude", [codex], "win32"), null, "Claude Code runs hooks under Git Bash, which starts it");
    const cursor = join(dir, "cursor.json");
    writeFileSync(cursor, JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: PLAIN.replace(/codex$/, "cursor") }] } }));
    assert.equal(quotedEntryNote("cursor", [cursor], "win32"), null, "the plain form needs no note");
    // A Codex entry whose plain command is fine but whose Windows command is quoted is still noted.
    writeFileSync(codex, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "npx -y @scopebond/hook@1.0.0 codex", commandWindows: QUOTED }] }] } }));
    assert.match(quotedEntryNote("codex", [codex], "win32"), /PowerShell/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("configuredHookCommands also reads a Codex entry's own commandWindows, once", () => {
  const dir = tmp();
  try {
    const file = join(dir, "hooks.json");
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "npx -y @scopebond/hook@1.0.0 codex", commandWindows: "npx.cmd -y @scopebond/hook@1.0.0 codex" }] }] } }));
    assert.deepEqual(configuredHookCommands(file), ["npx -y @scopebond/hook@1.0.0 codex", "npx.cmd -y @scopebond/hook@1.0.0 codex"]);
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: PLAIN, commandWindows: PLAIN }] }] } }));
    assert.deepEqual(configuredHookCommands(file), [PLAIN]);
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo hi", commandWindows: PLAIN }] }] } }));
    assert.deepEqual(configuredHookCommands(file), [PLAIN], "Scopebond named only in commandWindows");
    assert.equal(harnessHookIsOurs({ type: "command", command: "echo hi", commandWindows: PLAIN }), true);
    assert.equal(harnessHookIsOurs({ type: "command", command: "echo hi" }), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("uninstall removes only Scopebond's hook from a group another tool shares", () => {
  const dir = tmp();
  try {
    const file = join(dir, "settings.json");
    const mine = { type: "command", command: "my-own-hook --check" };
    writeFileSync(file, JSON.stringify({ theme: "dark", hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [mine, { type: "command", command: PLAIN.replace(/codex$/, "claude") }] },
        { matcher: "*", hooks: [{ type: "command", command: QUOTED.replace(/codex$/, "claude") }] },
        { matcher: "Edit", hooks: [{ type: "command", command: "formatter" }] },
      ],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo", commandWindows: PLAIN }] }],
    } }));
    assert.equal(removeHarnessConfig(file), true);
    const after = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(after.theme, "dark");
    assert.deepEqual(after.hooks.PreToolUse, [
      { matcher: "Bash", hooks: [mine] },
      { matcher: "Edit", hooks: [{ type: "command", command: "formatter" }] },
    ], "the shared group keeps its matcher and the other hook; a group of Scopebond's alone goes");
    assert.deepEqual(after.hooks.PostToolUse, [], "a hook naming Scopebond only in commandWindows is Scopebond's");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a folder named outside the console's code page is looked up correctly (Windows)", { skip: process.platform !== "win32" && "Windows only" }, (t) => {
  const root = tmp();
  try {
    const folder = join(root, "Café Ünïcode ž");
    mkdirSync(folder);
    const short = windowsShortPath(folder);
    assert.ok(short, "cmd answered");
    if (/\s/.test(short)) { t.skip("8.3 short names are switched off on this volume"); return; }
    assert.ok(short.toLowerCase().startsWith(root.toLowerCase().slice(0, 2)), short);
    assert.doesNotMatch(short, /\uFFFD|\?/, `no garbled characters: ${short}`);
    const plain = shellPlainWindowsPath(join(folder, "cli.js"));
    // The short name is either plain ASCII (a plain spelling) or refused (null): never a garbled path.
    if (plain) assert.match(plain, /^[A-Za-z]:\/[A-Za-z0-9._@~/-]+\/cli\.js$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("flush: a failed attempt with nothing left in the queue exits 1", () => {
  const out = flushOutcome({ pending: 0, lastError: "HTTP 503", backoff: null }, { routine: 0, until: null });
  assert.equal(out.exitCode, 1);
  assert.match(out.lines[0], /0 receipt\(s\) still pending \(last error: HTTP 503\)/);
});

test("flush: the held-until time carries its date when the window closes on another day", () => {
  const now = new Date(2026, 9, 13, 23, 58, 0).getTime();
  assert.equal(clockTime(new Date(2026, 9, 13, 23, 59, 10).getTime(), now), "2026-10-14 00:00", "rounded up past midnight: tomorrow's date");
  assert.equal(clockTime(new Date(2026, 9, 13, 23, 58, 30).getTime(), now), "23:59");
  assert.equal(clockTime(new Date(2026, 9, 14, 0, 2, 0).getTime(), now), "2026-10-14 00:02");
  const out = flushOutcome({ pending: 3, lastError: null, backoff: null }, { routine: 3, until: new Date(2026, 9, 14, 0, 2, 0).getTime() }, now);
  assert.equal(out.exitCode, 0);
  assert.match(out.lines[1], /3 routine record\(s\) held for the summary window until 2026-10-14 00:02/);
});
