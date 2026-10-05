// The stand-in workspace for the install and journey checks, from @scopebond/fake-cloud.
//
// In process:   const cloud = await startFakeCloud(); … cloud.state(); cloud.close();
// As a process: node fake-cloud.mjs --url-file <path> [--auto-approve]
//               (writes its URL there, runs until killed; --auto-approve approves each code on its
//               second poll, as a person who opened the page would)

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeCloud } from "@scopebond/fake-cloud";

export { startFakeCloud, kidForPem } from "@scopebond/fake-cloud";

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  const i = process.argv.indexOf("--url-file");
  const cloud = await startFakeCloud({ autoApprove: process.argv.includes("--auto-approve") });
  if (i > 0 && process.argv[i + 1]) writeFileSync(process.argv[i + 1], cloud.url);
  console.log(cloud.url);
}
