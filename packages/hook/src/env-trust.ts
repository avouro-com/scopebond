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
// the decision. A hook call refuses to decide while either is set (cli-main.ts), and doctor names it.
//
// The home folder is the operating system account's (`os.userInfo().homedir`), not HOME or USERPROFILE, which any program
// can change for the processes it starts. Where the two differ the account's wins, and doctor says so.
//
// This file is loaded by the engine shim before the engine on every hook call, so it imports only Node's built-ins and
// self.ts (which does the same).

import { homedir, userInfo } from "node:os";
import { isSignedBuild } from "./self.js";

/** The variables a signed build reads only from its hook command line. */
export const COMMAND_LINE_SETTINGS: readonly string[] = Object.freeze([
  "SCOPEBOND_HOME", "SCOPEBOND_POLICY_KEYS_JSON", "SCOPEBOND_PACK_ENGINE_LEVEL", "SCOPEBOND_POLICY_SYNC", "SCOPEBOND_POLICY_SYNC_MS",
]);

/** Whether `name` is one of those settings: the list above, and any later `SCOPEBOND_POLICY_SYNC…` variable. */
export function isCommandLineSetting(name: string): boolean {
  const upper = name.toUpperCase();
  return COMMAND_LINE_SETTINGS.includes(upper) || upper.startsWith("SCOPEBOND_POLICY_SYNC");
}

/** The flag the installer writes before each setting on the hook's command line. */
export const SETTING_FLAG = "--setting";

/** Set to "1" to read settings as the signed build does on any install (stricter only: tests use it). */
export const AS_SIGNED_BUILD_ENV = "SCOPEBOND_AS_SIGNED_BUILD";

/** The variables Node reads before the program starts that can load code into it. */
export const CODE_LOADING_VARS: readonly string[] = Object.freeze(["NODE_OPTIONS", "NODE_PATH"]);

/** Whether settings are read from the command line only: a signed build, or `SCOPEBOND_AS_SIGNED_BUILD=1`. */
export function commandLineOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return isSignedBuild() || env[AS_SIGNED_BUILD_ENV] === "1";
}

/** The `--setting NAME=VALUE` pairs in `argv`, for the settings above only. A later pair for the same name wins. */
export function commandLineSettings(argv: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== SETTING_FLAG) continue;
    const pair = argv[i + 1];
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const name = pair.slice(0, at).toUpperCase();
    if (isCommandLineSetting(name)) out.set(name, pair.slice(at + 1));
    i += 1;
  }
  return out;
}

/** `argv` without its `--setting NAME=VALUE` pairs (the commands never see them). */
export function withoutSettingArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === SETTING_FLAG && i + 1 < argv.length) {
      const pair = argv[i + 1];
      const at = pair.indexOf("=");
      if (at > 0 && isCommandLineSetting(pair.slice(0, at))) { i += 1; continue; }
    }
    out.push(argv[i]);
  }
  return out;
}

/** This process's own command line settings, read once (before `main` takes the flags out of `process.argv`). */
let ownSettings: Map<string, string> | null = null;
function processSettings(): Map<string, string> {
  ownSettings ??= commandLineSettings(process.argv.slice(2));
  return ownSettings;
}

/** Take the setting flags out of `process.argv`, keeping their values for `setting`; returns `argv` without them. */
export function takeSettingArgs(argv: readonly string[]): string[] {
  processSettings();
  const rest = process.argv.slice(2);
  const cleaned = withoutSettingArgs(rest);
  if (cleaned.length !== rest.length) process.argv.splice(2, rest.length, ...cleaned);
  return withoutSettingArgs(argv);
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

/** The code-loading variables set (to anything but blanks) in `env`. */
export function codeLoadingVariables(env: NodeJS.ProcessEnv = process.env): string[] {
  return CODE_LOADING_VARS.filter((name) => (env[name] ?? "").trim() !== "");
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
