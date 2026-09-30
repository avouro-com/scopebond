// "@scopebond/gateway/node" — Node-only helpers (fs / node:sqlite). Kept out of
// the package root so the core stays importable in edge runtimes.
export { loadOrCreateAttester } from "./node-keys.js";
export { FileReceiptStore, SqliteReceiptStore, SqliteCloudOutbox, openReceiptStore } from "./node-stores.js";
export type { SqliteCloudOutboxOptions } from "./node-stores.js";
export { DispatchStore, createDispatchGuard, DISPATCH_DB, CLOCK_TOLERANCE_MS } from "./dispatch-store.js";
export type { DispatchGuardConfig } from "./dispatch-store.js";
export { openDispatchGuard, readDispatchFile, readApprovalInbox, DISPATCH_FILE, APPROVAL_INBOX, DELEGATION_ENV } from "./dispatch-config.js";
export type { DispatchFile } from "./dispatch-config.js";
