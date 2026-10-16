// Case folding for JSON member names. The proxy reads member names exactly, as JSON-RPC defines them, but some
// upstream decoders match them case-insensitively: Go's encoding/json folds each character to its Unicode simple case
// folding ("ſ" is "s", the Kelvin sign is "k") and lets the later of two matching members win. Two member names with
// the same fold are therefore one member to such an upstream, and the proxy refuses a message that relies on that.
// Internal; not exported from the package.

// Simple-fold pairs that the full case mappings below do not join (each side upper-cases to several characters).
const EXTRA_FOLDS = new Map<number, number>([[0x1fd3, 0x0390], [0x1fe3, 0x03b0], [0xfb05, 0xfb06]]);

const oneChar = (s: string): string | undefined => (s.length === 1 || (s.length === 2 && s.codePointAt(0)! > 0xffff) ? s : undefined);

function foldChar(ch: string): string {
  const cp = ch.codePointAt(0)!;
  if (cp < 0x80) return ch.toLowerCase();
  const base = EXTRA_FOLDS.has(cp) ? String.fromCodePoint(EXTRA_FOLDS.get(cp)!) : ch;
  // Upper then lower case, each only when it maps to one character: every character of a simple-fold set ends on the
  // same one. It joins a few characters Go keeps apart (the dotless i with "i"), which only refuses more.
  const upper = oneChar(base.toUpperCase()) ?? base;
  return oneChar(upper.toLowerCase()) ?? upper;
}

/** The fold of a member name: two names with the same fold are the same member to a case-insensitive decoder. */
export function foldName(name: string): string {
  let out = "";
  for (const ch of name) out += foldChar(ch);
  return out;
}

const shown = (name: string): string => JSON.stringify(name.length > 64 ? `${name.slice(0, 64)}…` : name);

/** Why an object's member names are ambiguous to a case-insensitive decoder, or undefined: a member that folds to one of
 *  `members` without being spelled exactly like it, or two members with the same fold. */
export function memberVariantReason(object: Record<string, unknown>, members: readonly string[], where: string): string | undefined {
  const known = new Map(members.map((m) => [foldName(m), m]));
  const seen = new Map<string, string>();
  for (const key of Object.keys(object)) {
    const fold = foldName(key);
    const member = known.get(fold);
    if (member !== undefined && member !== key) return `${where} member ${shown(key)} is another spelling of "${member}"; send the exact member name`;
    const prior = seen.get(fold);
    if (prior !== undefined) return `${where} members ${shown(prior)} and ${shown(key)} differ only in case`;
    seen.set(fold, key);
  }
  return undefined;
}

/** Whether any object inside `value`, at any depth, holds two member names with the same fold. */
export function hasFoldDuplicateMembers(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) { for (const el of node) if (el !== null && typeof el === "object") stack.push(el); continue; }
    if (node === null || typeof node !== "object") continue;
    const seen = new Set<string>();
    for (const [key, child] of Object.entries(node)) {
      const fold = foldName(key);
      if (seen.has(fold)) return true;
      seen.add(fold);
      if (child !== null && typeof child === "object") stack.push(child);
    }
  }
  return false;
}
