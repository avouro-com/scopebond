// Preloaded into a hook process by the storage tests: on exit, write the process's peak resident memory (KB).
import { writeFileSync } from "node:fs";

const out = process.env.SCOPEBOND_RSS_OUT;
if (out) process.on("exit", () => { try { writeFileSync(out, String(process.resourceUsage().maxRSS)); } catch { /* best effort */ } });
