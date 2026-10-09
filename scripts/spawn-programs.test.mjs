// The published packages start programs by full path, never by a bare name: on Windows a spawn by bare name looks in the
// current folder before PATH (unless NoDefaultCurrentDirectoryInExePath is set, which Windows does not set by default),
// and the current folder of a hook, an MCP proxy or a pull request check is a project anyone can put a git.exe in. A
// program is named through `windowsSystemProgram` / `windowsTool` (Windows' own tools) or `programPath` / `findProgram`
// (PATH's absolute folders), or is this process's own `process.execPath`. The only names left are tools started on
// macOS or Linux alone, where the current folder is not searched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packages = fileURLToPath(new URL("../packages/", import.meta.url));
const SHIPPED = ["agent", "framework", "gateway", "github-action", "hook", "mcp", "sdk", "verify", "policy-schema"];
const POSIX_ONLY = new Set(["launchctl", "systemctl", "osascript", "zenity", "notify-send", "open", "xdg-open", "/bin/sh"]);
// A call to a child_process function (or a local `run` wrapper) and the text of its first argument. The program is a
// string literal when that argument is one, or is a conditional on a plain name with literal branches:
// `spawn("git", …)`, `spawn(win ? "npm.cmd" : "npm", …)`.
const CALL = /(?<![.\w])(spawn|spawnSync|execFile|execFileSync|execSync|exec|run)\(([^,)]*)/g;
const LITERAL = /(["'`])([^"'`]*)\1/g;

function literalPrograms(argument) {
  const text = argument.trim();
  if (/^["'`]/.test(text)) return [...text.matchAll(LITERAL)].slice(0, 1).map((m) => m[2]);
  if (/^[\w.!]+\s*\?/.test(text)) return [...text.matchAll(LITERAL)].map((m) => m[2]);
  return [];
}

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) out.push(...sources(file));
    else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(file);
  }
  return out;
}

test("the published packages start no program by a bare name a Windows spawn would look for in the current folder", () => {
  const found = [];
  for (const pkg of SHIPPED) {
    let files;
    try { files = sources(join(packages, pkg, "src")); } catch { continue; }
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (!/child_process/.test(text)) continue;
      for (const m of text.matchAll(CALL)) {
        for (const program of literalPrograms(m[2])) {
          if (POSIX_ONLY.has(program)) continue;
          const line = text.slice(0, m.index).split("\n").length;
          found.push(`${file.slice(packages.length)}:${line} ${m[1]}("${program}")`);
        }
      }
    }
  }
  assert.deepEqual(found, [], `start these by full path (windowsSystemProgram / programPath):\n${found.join("\n")}`);
});
