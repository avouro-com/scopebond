export { createGateway, noopExecutor } from "./app.js";
export type { Gateway, GatewayConfig, Executor, ActionRequest, ActionResult } from "./app.js";
export { createHttpExecutor } from "./executors.js";
export type { HttpExecutorOptions } from "./executors.js";
export { evaluate } from "./engine.js";
export type { Decision } from "./engine.js";
export {
  MemoryReceiptStore, createAttester, attesterFromPrivateKeyPem, verifyReceipt,
  buildReceipt, canonical, sha256, intentHash, ed25519JwkToSpkiPem, deriveKid,
} from "./receipts.js";
export type { ReceiptStore, SignedReceipt, ReceiptPayload, Attester, RealtimeResult, ReceiptVerification, Anchor } from "./receipts.js";
export { handleMcp } from "./mcp.js";
export { merkleRoot, merkleProof, verifyProof } from "./anchor.js";
export type { ProofStep } from "./anchor.js";

// Edge (Cloudflare Workers) support — WebCrypto attester + KV store. Edge-safe.
export { createWebCryptoAttester, generateAttesterJwk } from "./webcrypto.js";
export type { Ed25519Jwk } from "./webcrypto.js";
export { KvReceiptStore, loadOrCreateKvAttester, createWorkerGateway } from "./workers.js";
export type { KvLike } from "./workers.js";
export { createCloudExporter, withCloudExporter } from "./cloud.js";
export type { CloudExporter, CloudExporterOptions } from "./cloud.js";
