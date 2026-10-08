#!/usr/bin/env node
// scopebond-agent: run, look at and control the Scopebond Agent for this user. This is the program npm installs and
// autostart starts (`cli.js run`); the commands themselves are in cli-main.ts.
import { main } from "./cli-main.js";

void main(process.argv.slice(2)).catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
