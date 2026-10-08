// An npm install is listed in Windows Settings -> Apps; its Uninstall runs the agent's own uninstall, then npm's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appsEntryValues, uninstallScript, writeAppsEntry, removeAppsEntry, UNINSTALL_KEY } from "../dist/index.js";

test("the entry names Scopebond, Avouro LLC and the version, and its Uninstall runs the script with no administrator rights", () => {
  const values = Object.fromEntries(appsEntryValues({ version: "0.5.3", script: "C:\\Users\\Ann\\.scopebond\\uninstall-agent.ps1", home: "C:\\Users\\Ann\\.scopebond" }).map(([n, t, d]) => [n, { t, d }]));
  assert.equal(UNINSTALL_KEY, "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ScopebondAgent", "per user: no administrator rights");
  assert.deepEqual(values.DisplayName, { t: "REG_SZ", d: "Scopebond Agent" });
  assert.deepEqual(values.Publisher, { t: "REG_SZ", d: "Avouro LLC" });
  assert.deepEqual(values.DisplayVersion, { t: "REG_SZ", d: "0.5.3" });
  assert.equal(values.UninstallString.d, 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\Ann\\.scopebond\\uninstall-agent.ps1"');
  assert.match(values.QuietUninstallString.d, /-WindowStyle Hidden -File "/);
  assert.deepEqual([values.NoModify, values.NoRepair], [{ t: "REG_DWORD", d: "1" }, { t: "REG_DWORD", d: "1" }]);
});

test("the script runs the agent's uninstall, then npm's, then removes the entry; paths are data, quotes doubled", () => {
  const script = uninstallScript({
    node: "C:\\Program Files\\nodejs\\node.exe",
    cli: "C:\\Users\\O'Brien\\AppData\\Roaming\\npm\\node_modules\\@scopebond\\agent\\dist\\cli.js",
    npm: "C:\\Program Files\\nodejs\\npm.cmd",
  });
  assert.ok(script.includes("$cli = 'C:\\Users\\O''Brien\\AppData"), script);
  const agent = script.indexOf("$cli uninstall");
  const npm = script.indexOf("& $npm uninstall -g @scopebond/agent");
  const entry = script.indexOf("reg.exe delete 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ScopebondAgent' /f");
  assert.ok(agent > 0 && npm > agent && entry > npm, "agent uninstall, then npm, then the entry");
  assert.ok(script.includes("$cli uninstall }"), "the Scopebond folder stays unless the person asks (no --purge)");
  assert.doesNotMatch(script, /Invoke-Expression|iex /);
});

test("off Windows there is no entry to write or remove", () => {
  assert.equal(writeAppsEntry("/tmp/x", { version: "1.0.0", cli: "/x/cli.js" }, "linux"), null);
  assert.equal(removeAppsEntry("/tmp/x", "darwin"), null);
});
