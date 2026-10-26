// The settings an installer puts on the hook's command line (`--setting NAME=VALUE` after the command), which a signed build
// reads in place of the environment (env-trust.ts). Kept apart, with no imports, so self.ts can pass this process's own
// settings on to the hook commands it starts.

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
export function processSettings(): Map<string, string> {
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

/** This process's own command-line settings as arguments, to pass to a hook command it starts (the child is the same build
 *  and reads them the same way). */
export function ownSettingArgs(): string[] {
  return [...processSettings()].flatMap(([name, value]) => [SETTING_FLAG, `${name}=${value}`]);
}
