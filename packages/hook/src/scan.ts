// Option scanning shared by the typed-operation derivations.

export interface Scanned { positionals: string[]; flags: Map<string, string | true> }

export function scan(argv: string[], valued: readonly string[]): Scanned {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const takes = new Set(valued);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (t.startsWith("--") && t.includes("=")) { const at = t.indexOf("="); flags.set(t.slice(0, at), t.slice(at + 1)); continue; }
    if (t.startsWith("-") && t.length > 1) {
      if (takes.has(t)) { flags.set(t, argv[i + 1] ?? ""); i += 1; } else flags.set(t, true);
      continue;
    }
    positionals.push(t);
  }
  return { positionals, flags };
}

export const flagValue = (s: Scanned, ...names: string[]): string | undefined => {
  for (const n of names) { const v = s.flags.get(n); if (typeof v === "string" && v !== "") return v; }
  return undefined;
};

