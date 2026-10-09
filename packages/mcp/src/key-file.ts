// The proxy's local secret file. It is the gateway's: read and made without a separate existence check (a check followed by
// a read or write races a path swap between the two), written to a new file that is owner-only from its first byte and
// complete when it appears at its name, so a file or link someone else placed there never gets the key, and proxies that
// start at the same moment all use the same key.

export { loadOrCreateHexKey } from "@scopebond/gateway/node";
