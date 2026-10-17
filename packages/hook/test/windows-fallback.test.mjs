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
  nativeHookCommand, shellPlainWindowsPath, windowsShortPath, flushOutcome, clockTime, isScopebondHookCommand, writeHarnessConfig, wireLifecycleHooks,
} from "../dist/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "sb-winfallback-"));
const QUOTED = `"C:\\Program Files\\nodejs\\node.exe" "D:\\a b\\node_modules\\@scopebond\\hook\\dist\\cli.js" codex`;
const PLAIN = "C:/PROGRA~1/nodejs/node.exe D:/x/node_modules/@scopebond/hook/dist/cli.js codex";

test("a quoted path Git Bash expands even inside quotes ($, backtick) is refused with a clear error; % and ! are written", () => {
  for (const bad of ["D:\\a$b\\cli.js", "D:\\a`b\\cli.js"]) {
    assert.throws(() => refuseUnsafeQuotedPaths(["C:\\nodejs\\node.exe", bad]), /expands .* even inside quotes.*no \$ or backtick/, bad);
  }
  for (const ok of ["D:\\100%\\cli.js", "D:\\wow!\\cli.js", "D:\\a b (x) & c\\cli.js"]) assert.doesNotThrow(() => refuseUnsafeQuotedPaths(["C:\\Program Files\\nodejs\\node.exe", ok]), ok);
});

test("a folder with %, ! or & in its name still gets its short name: the path goes to cmd.exe unparsed (Windows)", { skip: process.platform !== "win32" && "Windows only" }, (t) => {
  const root = tmp();
  try {
    for (const name of ["100% sure", "wow! yes", "a & b ^c"]) {
      const folder = join(root, name);
      mkdirSync(folder);
      const short = windowsShortPath(folder);
      if (short && /\s/.test(short)) { t.skip("8.3 short names are switched off on this volume"); return; }
      assert.ok(short && !short.includes(" "), `${name}: ${short}`);
      assert.equal(short.slice(0, 2).toLowerCase(), root.slice(0, 2).toLowerCase(), short);
    }
    // A short name keeps `%`, `!` and `&` when they fall in its first characters (`100%SU~1`): then there is no plain
    // spelling and the quoted form is used (cmd.exe and Git Bash start it; doctor notes it). Otherwise the plain one.
    for (const name of ["100% sure", "wow! yes", "a & b ^c"]) {
      const short = windowsShortPath(join(root, name));
      const plain = shellPlainWindowsPath(join(root, name, "cli.js"));
      if (/[%!&^]/.test(short.split("\\").pop())) assert.equal(plain, null, `${name}: ${short}`);
      else assert.match(plain, /^[A-Za-z]:\/[A-Za-z0-9._@~/-]+\/cli\.js$/, `${name}: ${short}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a tool's own cli.js, or a path that merely mentions scopebond, is not taken for Scopebond's hook", () => {
  assert.equal(isScopebondHookCommand("node /srv/tools/cli.js claude"), false, "a bare cli.js is someone else's");
  assert.equal(isScopebondHookCommand("/opt/scopebond-mirror/bin/run claude"), false, "scopebond in a folder name is not enough");
  assert.equal(isScopebondHookCommand(`"C:\\Users\\u\\scopebond-notes\\cli.js" cursor`), false);
  for (const ours of [
    "npx -y @scopebond/hook@1.0.0 claude", "scopebond claude", "scopebond-hook cursor", "C:/PROGRA~1/Scopebond/scopebond-agent.exe hook codex",
    `"C:\\x\\scopebond.cmd" cursor`, PLAIN, QUOTED, "/usr/bin/node /srv/agent/.scopebond/runtime/1.0.0/cli.js claude",
  ]) assert.equal(isScopebondHookCommand(ours), true, ours);
});

test("writing the hook keeps a group another tool shares: its matcher, its other hooks, and Scopebond's own timeout", () => {
  const dir = tmp();
  try {
    const file = join(dir, "hooks.json");
    const theirs = { type: "command", command: "my-linter --check" };
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [
      { matcher: "Bash", hooks: [theirs, { type: "command", command: QUOTED, timeout: 90 }] },
      { hooks: [{ type: "command", command: "audit-log" }] },
    ] } }));
    writeHarnessConfig(file, "codex", PLAIN);
    const list = JSON.parse(readFileSync(file, "utf8")).hooks.PreToolUse;
    assert.equal(list.length, 2);
    assert.equal(list[0].matcher, "Bash", "the group's matcher stays");
    assert.deepEqual(list[0].hooks[0], theirs, "the other tool's hook stays, first");
    assert.equal(list[0].hooks[1].command, PLAIN);
    assert.equal(list[0].hooks[1].timeout, 90, "Scopebond's own timeout is carried");
    assert.deepEqual(list[1], { hooks: [{ type: "command", command: "audit-log" }] });
    const before = readFileSync(file, "utf8");
    writeHarnessConfig(file, "codex", PLAIN);
    assert.equal(readFileSync(file, "utf8"), before, "a second write changes nothing");
    // The Claude Code session and after-action entries keep a shared group the same way.
    const claude = join(dir, "settings.json");
    writeFileSync(claude, JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "formatter" }, { type: "command", command: QUOTED.replace(/codex$/, "claude") }] }] } }));
    wireLifecycleHooks(claude, PLAIN.replace(/codex$/, "claude"));
    const post = JSON.parse(readFileSync(claude, "utf8")).hooks.PostToolUse;
    assert.deepEqual(post, [{ matcher: "Edit", hooks: [{ type: "command", command: "formatter" }, { type: "command", command: PLAIN.replace(/codex$/, "claude") }] }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  assert.equal(isQuotedWindowsHookCommand(`"\\\\server\\share\\node.exe" "\\\\server\\share\\@scopebond\\hook\\dist\\cli.js" codex`), true, "a network path, quoted");
  assert.equal(isQuotedWindowsHookCommand("npx -y @scopebond/hook@1.0.0 codex"), false);
});

test("status and doctor note a quoted Codex or Cursor entry on Windows: it may not start under PowerShell", () => {
  const dir = tmp();
  try {
    const codex = join(dir, "codex.json");
    writeFileSync(codex, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: QUOTED, commandWindows: QUOTED }] }] } }));
    assert.match(quotedEntryNote("codex", [null, undefined, codex], "win32"),
      /uses the quoted form \(written by an earlier release, or this computer has no short name for one of its folders\), which may not start under PowerShell; the Scopebond Agent rewrites it when it can — or reinstall/);
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
