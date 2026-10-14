// The uninstall notice (`reportUninstall`) against the shared stand-in workspace (@scopebond/fake-cloud): the real client's
// request is one the workspace's route takes, and its answer is read as the workspace means it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { startFakeCloud } from "@scopebond/fake-cloud";
import { reportUninstall } from "../dist/index.js";

async function connectionTo(cloud) {
  const public_key_pem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  const res = await fetch(cloud.url + "/v1/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enrollment_token: "sbe_fake_hook", public_key_pem }) });
  return { url: cloud.url, credential: (await res.json()).credential };
}

test("reportUninstall: the workspace is told, with the hook version, and says whether the removal was allowed", async () => {
  const cloud = await startFakeCloud();
  try {
    const connection = await connectionTo(cloud);
    assert.deepEqual(await reportUninstall(connection, { purge: true, hookVersion: "1.2.3" }), { workspace: cloud.url, told: true, authorized: false });
    cloud.setUninstallAuthorized(true);
    assert.deepEqual(await reportUninstall(connection, { purge: false, hookVersion: "1.2.3" }), { workspace: cloud.url, told: true, authorized: true });
    assert.deepEqual(cloud.state().uninstalls, [
      { purge: true, hook_version: "1.2.3", header_hook_version: "1.2.3" },
      { purge: false, hook_version: "1.2.3", header_hook_version: "1.2.3" },
    ]);
  } finally { await cloud.close(); }
});

test("reportUninstall: a refused credential, a failing or unreachable workspace leave the workspace untold", async () => {
  const cloud = await startFakeCloud();
  try {
    const connection = await connectionTo(cloud);
    const untold = { workspace: cloud.url, told: false, authorized: null };
    assert.deepEqual(await reportUninstall({ ...connection, credential: "sbm_wrong" }, { purge: false, hookVersion: "1.2.3" }), untold);
    cloud.fault("uninstall", { status: 500, times: 1 });
    assert.deepEqual(await reportUninstall(connection, { purge: false, hookVersion: "1.2.3" }), untold);
    cloud.fault("uninstall", { drop: true, times: 1 });
    assert.deepEqual(await reportUninstall(connection, { purge: false, hookVersion: "1.2.3" }), untold);
    cloud.fault("uninstall", { delayMs: 2_000, times: 1 });
    assert.deepEqual(await reportUninstall(connection, { purge: false, hookVersion: "1.2.3" }, fetch, 200), untold, "bounded by its time limit");
    assert.deepEqual(cloud.state().uninstalls, [], "nothing reached the route");
  } finally { await cloud.close(); }
});
