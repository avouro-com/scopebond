// Every call this computer makes to its workspace says which hook version makes it (`x-scopebond-hook-version`): the rules
// check and its confirmation, record delivery and summaries, observations, credential renewal, recovery and the uninstall
// notice. A workspace can then hold a version floor (answer an older hook with an update notice, or send it only the
// settings it understands) on every route, not only the rules check.

import { hookVersion } from "./version.js";

export const HOOK_VERSION_HEADER = "x-scopebond-hook-version";

let cached: string | null = null;
const version = (): string => (cached ??= hookVersion());

/** The same request headers with the hook version added, in the form they were given (a plain object stays a plain object,
 *  so callers and tests that read it keep working). A version already set is left as it is. */
export function withHookVersion(headers: HeadersInit | undefined, value: string = version()): HeadersInit {
  if (!value) return headers ?? {};
  if (headers instanceof Headers) {
    const copy = new Headers(headers);
    if (!copy.has(HOOK_VERSION_HEADER)) copy.set(HOOK_VERSION_HEADER, value);
    return copy;
  }
  if (Array.isArray(headers)) {
    return headers.some(([name]) => name.toLowerCase() === HOOK_VERSION_HEADER) ? headers : [...headers, [HOOK_VERSION_HEADER, value]];
  }
  const plain = headers ?? {};
  return Object.keys(plain).some((name) => name.toLowerCase() === HOOK_VERSION_HEADER) ? plain : { ...plain, [HOOK_VERSION_HEADER]: value };
}

/** A fetch that adds the hook version to every request it makes. */
export function versionedFetch(fetchImpl?: typeof fetch, value?: string): typeof fetch {
  const inner = fetchImpl ?? ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => globalThis.fetch(input, init));
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    inner(input, { ...init, headers: withHookVersion(init?.headers ?? (input instanceof Request ? input.headers : undefined), value) }));
}
