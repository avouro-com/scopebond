// Prove a receipt is in the gateway's signed receipt log, and verify that proof offline.
//   1. The gateway decides several actions (one receipt each), then anchors the log: a v2
//      anchor is the RFC 9162 Merkle root over the receipts, Ed25519-signed by the attester.
//   2. The gateway serves an inclusion proof (audit path) for one receipt. It never asserts
//      inclusion itself; the client checks it.
//   3. `@scopebond/verify/anchor` verifies the anchor signature and the inclusion proof with
//      WebCrypto only (runs the same in a browser or Worker), and recomputes the proof
//      locally to show the server's proof is the RFC 9162 one.
// Run: `pnpm -r build && node examples/verify-anchor-inclusion.mjs`
import { readFileSync } from "node:fs";
import { createGateway, StaticPrincipalKeyRegistry } from "@scopebond/gateway";
import { createSigner } from "@scopebond/sdk";
import {
  inclusionProof, receiptLeafHash, verifyAnchorSignature, verifyInclusionProof,
} from "@scopebond/verify/anchor";

// --- 1. Receipts, then a signed v2 anchor ---------------------------------------------
const policy = JSON.parse(readFileSync(new URL("./policy.json", import.meta.url), "utf8"));
const agent = createSigner();
policy.clauses.find((clause) => clause.type === "key_policy").active_keys = [agent.kid];
const keys = new StaticPrincipalKeyRegistry([{
  kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active",
}]);
const gateway = createGateway({ policy, authentication: { keys } });

const amounts = [100000, 250000, 500000, 2000000, 75000]; // 2000000 is over the cap: denied, still receipted
const receipts = [];
for (const amount of amounts) {
  const res = await gateway.handleAction(agent.sign({ action_type: "payout.create", asset: "USDC", amount }));
  receipts.push(res.receipt);
}
const anchor = await gateway.anchor(); // POST /v1/anchor over HTTP (control-authenticated)
console.log(`anchored ${anchor.tree_size} receipts: seq=${anchor.seq} algo=${anchor.algo}`);
console.log(`  root = ${anchor.root}`);

// --- 2. Fetch the inclusion proof for one receipt ------------------------------------
const target = receipts[2]; // the $5,000 payout
const leaf = await receiptLeafHash(target.payload);
const proof = await (await gateway.app.request(`/v1/anchors/proof?leaf=${leaf}`)).json();
const { jwk } = await (await gateway.app.request("/v1/attester")).json();
console.log(`proof for receipt amount=${target.payload.intent.amount}: leaf_index=${proof.leaf_index} tree_size=${proof.tree_size} audit_path=${proof.audit_path.length} hashes`);

// --- 3. Verify offline ---------------------------------------------------------------
const signatureOk = await verifyAnchorSignature(proof.anchor, jwk);
const inclusionOk = await verifyInclusionProof({
  leaf_hash: leaf, leaf_index: proof.leaf_index, tree_size: proof.anchor.tree_size,
  audit_path: proof.audit_path, root: proof.anchor.root,
});
console.log("\nverifying with @scopebond/verify/anchor:");
console.log(`  anchor signature: ${signatureOk ? "VALID" : "INVALID"}`);
console.log(`  inclusion proof:  ${inclusionOk ? "VALID" : "INVALID"}`);

// The client can also recompute the proof from the receipts it holds.
const local = await inclusionProof(await Promise.all(receipts.map((r) => receiptLeafHash(r.payload))), 2);
const same = JSON.stringify(local.audit_path) === JSON.stringify(proof.audit_path);
console.log(`  locally computed audit path matches the server's: ${same ? "yes" : "no"}`);

// Negative cases: the same audit path at the wrong position, and a tampered anchor.
const wrongIndex = await verifyInclusionProof({
  leaf_hash: leaf, leaf_index: proof.leaf_index + 1, tree_size: proof.anchor.tree_size,
  audit_path: proof.audit_path, root: proof.anchor.root,
});
console.log(`  same proof, wrong leaf_index (${proof.leaf_index + 1}): ${wrongIndex ? "VALID" : "INVALID"}`);
const forged = { ...proof.anchor, tree_size: proof.anchor.tree_size - 1 };
console.log(`  anchor with tree_size edited: ${(await verifyAnchorSignature(forged, jwk)) ? "VALID" : "INVALID"}`);
