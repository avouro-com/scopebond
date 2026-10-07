// SB392: Reconnect… from the tray runs the hook's sign-in for the workspace this computer is connected to, reads the code,
// and opens the approval page only on that workspace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLoginPrompt, startReconnect } from "../dist/reconnect.js";

const prompt = (url, code) => `To connect this computer, open:\n\n  ${url}\n\nand check that it shows the code  ${code}\n\nWaiting for approval…\n`;

function fakeSpawn(lines, exitCode = 0) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    setTimeout(() => { for (const line of lines) child.stdout.emit("data", Buffer.from(line)); setTimeout(() => child.emit("exit", exitCode), 5); }, 5);
    return child;
  };
  return { spawn, calls };
}

function connectedHome(url = "https://cloud.example.test") {
  const dir = mkdtempSync(join(tmpdir(), "sb-reconnect-"));
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url, credential: "sbm_x" }));
  return dir;
}

test("the code and link are read from the sign-in's own words", () => {
  assert.deepEqual(parseLoginPrompt(prompt("https://cloud.example.test/app/device?code=BCDF-GHJK", "BCDF-GHJK")),
    { user_code: "BCDF-GHJK", verification_url: "https://cloud.example.test/app/device?code=BCDF-GHJK" });
  assert.equal(parseLoginPrompt("could not reach the workspace"), null);
});

test("signs in for the connected workspace only, opens its page, and reports when it finishes", async () => {
  const dir = connectedHome();
  const { spawn, calls } = fakeSpawn([prompt("https://cloud.example.test/app/device?code=BCDF-GHJK", "BCDF-GHJK")]);
  const opened = [];
  let finished = null;
  const result = await startReconnect(dir, (ok) => { finished = ok; }, spawn, (url) => opened.push(url));
  assert.deepEqual(result.started, { user_code: "BCDF-GHJK", verification_url: "https://cloud.example.test/app/device?code=BCDF-GHJK" });
  assert.deepEqual(calls[0].args.slice(1), ["login", "https://cloud.example.test", "--no-install"]);
  assert.equal(calls[0].options.env.SCOPEBOND_HOME, dir);
  assert.deepEqual(opened, ["https://cloud.example.test/app/device?code=BCDF-GHJK"]);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(finished, true);
});

test("a link to another site is never opened, and a computer never connected cannot reconnect", async () => {
  const { spawn } = fakeSpawn([prompt("https://evil.example/app/device?code=BCDF-GHJK", "BCDF-GHJK")]);
  const opened = [];
  await startReconnect(connectedHome(), () => {}, spawn, (url) => opened.push(url));
  assert.deepEqual(opened, []);
  const never = mkdtempSync(join(tmpdir(), "sb-reconnect-none-"));
  assert.match((await startReconnect(never, () => {}, spawn, () => {})).error, /never connected/);
});
