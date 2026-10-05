#!/usr/bin/env node
// scopebond-fake-cloud [--port N] [--url-file <path>] [--auto-approve] [--fault <route>=<what>]…
//
//   --auto-approve        approve each sign-in code on its second poll, as a person who opened the page would
//   --fault ingest=500x2  answer the next two deliveries with HTTP 500 (also 401, 409, 429, …)
//   --fault ingest=slow:3000   answer each delivery three seconds late
//   --fault ingest=drop   close each delivery's connection with no answer
//
// Prints the URL (and writes it to --url-file), then runs until stopped.

import { writeFileSync } from "node:fs";
import { startFakeCloud, type Fault, type FakeRoute } from "./index.js";

export function parseFault(spec: string): { route: FakeRoute; fault: Fault } {
  const [route, what = ""] = spec.split("=");
  const [kind, times] = what.split("x");
  const fault: Fault = {};
  if (kind === "drop") fault.drop = true;
  else if (kind.startsWith("slow:")) fault.delayMs = Number(kind.slice(5));
  else if (/^\d{3}$/.test(kind)) fault.status = Number(kind);
  else throw new Error(`unknown fault "${spec}" (use <route>=<status>[xN], <route>=slow:<ms> or <route>=drop)`);
  if (times) fault.times = Number(times);
  return { route: route as FakeRoute, fault };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const cloud = await startFakeCloud({ port: Number(value("--port") ?? 0), autoApprove: args.includes("--auto-approve") });
  args.forEach((a, i) => { if (a === "--fault" && args[i + 1]) { const { route, fault } = parseFault(args[i + 1]); cloud.fault(route, fault); } });
  const file = value("--url-file");
  if (file) writeFileSync(file, cloud.url);
  console.log(cloud.url);
}

if (process.argv[1] && /cli\.js$/.test(process.argv[1])) void main();
