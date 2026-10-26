// Which parts of the environment a hook call may believe.
//
// A few variables change what the hook trusts or where it keeps its state: the Scopebond home (SCOPEBOND_HOME), extra keys
// for workspace rules (SCOPEBOND_POLICY_KEYS_JSON), the rule-pack engine level (SCOPEBOND_PACK_ENGINE_LEVEL) and the
// workspace rules check (SCOPEBOND_POLICY_SYNC, SCOPEBOND_POLICY_SYNC_MS). An npm install is a developer's tool and keeps
// reading them from the environment (tests and CI set them). The signed builds (the single executable, and the signed engine
// bundle it loads) read them only from the hook's own command line, where the installer put them: `--setting NAME=VALUE`
// after the command. Anything else that can set an environment variable for the next session (a shell startup file, `setx`)
// cannot move a signed install's state or add a key it trusts.
//
// Node itself reads NODE_OPTIONS and NODE_PATH before any of this code runs: they can load code into the process that makes
// the decision. A hook call refuses to decide while NODE_PATH is set, or NODE_OPTIONS carries a flag that loads or changes
// code (a preload or loader, code to run, the inspector, the policy file, …; memory and diagnostics flags are fine), and
// doctor names it (cli-main.ts).
//
// The home folder is the operating system account's (`os.userInfo().homedir`), not HOME or USERPROFILE, which any program
// can change for the processes it starts. Where the two differ the account's wins, and doctor says so.
//
// This file is loaded by the engine shim before the engine on every hook call, so it imports only Node's built-ins and
// self.ts and setting-args.ts (which do the same).

import { homedir, userInfo } from "node:os";
import { isSignedBuild } from "./self.js";
import { commandLineSettings, isCommandLineSetting, processSettings, COMMAND_LINE_SETTINGS } from "./setting-args.js";

export { COMMAND_LINE_SETTINGS, SETTING_FLAG, commandLineSettings, isCommandLineSetting, takeSettingArgs, withoutSettingArgs } from "./setting-args.js";

/** Set to "1" to read settings as the signed build does on any install (stricter only: tests use it). */
export const AS_SIGNED_BUILD_ENV = "SCOPEBOND_AS_SIGNED_BUILD";

/** The variables Node reads before the program starts that can load code into it (NODE_OPTIONS only through some flags). */
export const CODE_LOADING_VARS: readonly string[] = Object.freeze(["NODE_OPTIONS", "NODE_PATH"]);

/** Whether settings are read from the command line only: a signed build, or `SCOPEBOND_AS_SIGNED_BUILD=1`. */
export function commandLineOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return isSignedBuild() || env[AS_SIGNED_BUILD_ENV] === "1";
}

/** The value of one setting as this process may believe it: from the command line, else (an npm install only) from the
 *  environment; undefined when neither gives it. */
export function setting(name: string, env: NodeJS.ProcessEnv = process.env, argv?: readonly string[], onlyCommandLine: boolean = commandLineOnly(env)): string | undefined {
  const upper = name.toUpperCase();
  const fromCommandLine = (argv ? commandLineSettings(argv) : processSettings()).get(upper);
  if (fromCommandLine !== undefined) return fromCommandLine;
  return onlyCommandLine && isCommandLineSetting(upper) ? undefined : env[name];
}

/** The settings as one environment-shaped object, for functions that take an `env` (policy keys, the pack engine level). */
export function settingsEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of COMMAND_LINE_SETTINGS) {
    const value = setting(name, env);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** The settings set in the environment that this build does not read from there (for doctor). */
export function ignoredSettings(env: NodeJS.ProcessEnv = process.env, onlyCommandLine: boolean = commandLineOnly(env)): string[] {
  if (!onlyCommandLine) return [];
  return Object.keys(env).filter((name) => isCommandLineSetting(name) && env[name] !== undefined && !processSettings().has(name.toUpperCase())).sort();
}

/** The NODE_OPTIONS flags that load, run or change the code in the process, or open it to another program: preloads and
 *  loaders, code given on the command line, the inspector and debugger, the policy file, the OpenSSL config, an env file,
 *  and the switches that disable or expose parts of Node. Matched on the flag name (before any `=`), `_` read as `-`. */
const CODE_LOADING_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "--experimental-policy", "--policy-integrity", "--eval", "-e", "--print", "-p", "--openssl-config"]);
const CODE_LOADING_FLAG_PREFIXES = ["--inspect", "--debug", "--disable-", "--expose", "--env-file"];

/** Split a NODE_OPTIONS value into its words as Node does: whitespace separates, double quotes group (a backslash in them
 *  takes the next character as it is). Single quotes are taken as quotes too. Null when a quote is left open. */
export function nodeOptionWords(value: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < value.length) word += value[++i];
      else word += c;
    } else if (c === '"' || c === "'") { quote = c; inWord = true; }
    else if (/\s/.test(c)) { if (inWord) words.push(word); word = ""; inWord = false; }
    else { word += c; inWord = true; }
  }
  if (quote) return null;
  if (inWord) words.push(word);
  return words;
}

/** The flags in a NODE_OPTIONS value that can load or change code (see `CODE_LOADING_FLAGS`); `["(unreadable)"]` when the
 *  value cannot be split into words, which counts as one. Memory and diagnostics flags (`--max-old-space-size`,
 *  `--no-warnings`, `--enable-source-maps`, …) are not among them. */
export function codeLoadingNodeOptions(value: string): string[] {
  const words = nodeOptionWords(value);
  if (!words) return ["(unreadable)"];
  const found: string[] = [];
  for (const word of words) {
    if (!word.startsWith("-")) continue;
    const name = word.split("=")[0].replace(/_/g, "-").toLowerCase();
    if (CODE_LOADING_FLAGS.has(name) || CODE_LOADING_FLAG_PREFIXES.some((p) => name.startsWith(p))) found.push(name);
  }
  return found;
}

/** The code-loading variables in `env`: NODE_PATH set to anything but blanks, and NODE_OPTIONS when it carries a flag that
 *  can load or change code (or cannot be read). */
export function codeLoadingVariables(env: NodeJS.ProcessEnv = process.env): string[] {
  return CODE_LOADING_VARS.filter((name) => {
    const value = env[name] ?? "";
    if (value.trim() === "") return false;
    return name === "NODE_OPTIONS" ? codeLoadingNodeOptions(value).length > 0 : true;
  });
}

/** `codeLoadingVariables`, each named with what makes it one: `NODE_OPTIONS (--require)`, `NODE_PATH`. */
export function describeCodeLoading(env: NodeJS.ProcessEnv = process.env): string[] {
  return codeLoadingVariables(env).map((name) => (name === "NODE_OPTIONS" ? `NODE_OPTIONS (${[...new Set(codeLoadingNodeOptions(env[name] ?? ""))].join(", ")})` : name));
}

/** The operating system account's home folder (`os.userInfo().homedir`); `os.homedir()` only when the account has none. */
export function accountHome(): string {
  try {
    const home = userInfo().homedir;
    if (typeof home === "string" && home !== "") return home;
  } catch { /* no account entry (some containers) */ }
  return homedir();
}

/** The home folder HOME or USERPROFILE names when it is not the account's, else null (for doctor). */
export function movedHome(): string | null {
  let fromEnv: string;
  try { fromEnv = homedir(); } catch { return null; }
  const account = accountHome();
  const fold = (p: string): string => {
    const s = p.replace(/[\\/]+$/, "");
    return process.platform === "win32" || process.platform === "darwin" ? s.toLowerCase() : s;
  };
  return fold(fromEnv) === fold(account) ? null : fromEnv;
}
