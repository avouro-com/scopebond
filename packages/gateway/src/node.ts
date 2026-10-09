// "@scopebond/gateway/node" — Node-only helpers (fs / node:sqlite). Kept out of
// the package root so the core stays importable in edge runtimes.
export { loadOrCreateAttester } from "./node-keys.js";
export { ensurePrivateDir } from "./node-permissions.js";
export { keepOwnerOnly, loadOrCreateHexKey, placeOwnerOnly } from "./node-files.js";
export { FileReceiptStore, SqliteReceiptStore, SqliteCloudOutbox, openReceiptStore } from "./node-stores.js";
export type { StoreMaintenanceOptions, StoreMaintenanceReport } from "./node-stores.js";
export type { SqliteCloudOutboxOptions } from "./node-stores.js";
export { CHAIN_HEADS_FILE, MAX_HEADS_PER_CHAIN, chainHeadRecorder, keptHeads, mergeChainHead, readChainHeads, recordChainHead } from "./node-chain-heads.js";
export type { ChainHeadsState } from "./node-chain-heads.js";
export { DispatchStore, createDispatchGuard, DISPATCH_DB, CLOCK_TOLERANCE_MS } from "./dispatch-store.js";
export type { DispatchGuardConfig } from "./dispatch-store.js";
export { openApprovalBinder, openDispatchGuard, openCloudSource, targetIdFor, BINDING_KEY_FILE, TARGET_ID_DOMAIN, readDispatchFile, readApprovalInbox, DISPATCH_FILE, APPROVAL_INBOX, DELEGATION_ENV } from "./dispatch-config.js";
export type { DispatchFile, ApprovalBinder } from "./dispatch-config.js";
