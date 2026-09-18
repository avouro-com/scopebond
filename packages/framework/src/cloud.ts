// @scopebond/framework → Scopebond Cloud: enroll the guard's countersigning key with
// a workspace so signed-intent receipts are mirrored to the hosted portal. Reuses the
// gateway's enrollment (D40); pass the resulting connection as `cloud` to
// `createToolGuard`, using the SAME attesterKeyPem for both so ingest accepts the
// receipts (their attester_kid must match the enrolled key).

import { completeCloudEnrollment, attesterFromPrivateKeyPem } from "@scopebond/gateway";
import type { CloudEnrollmentBundle, CloudEnrollmentResult } from "@scopebond/gateway";

export interface FrameworkConnection extends CloudEnrollmentResult {
  url: string;
}

/** Enroll `attesterKeyPem` with a workspace using the portal's one-use handoff and
 *  return the scoped connection to pass to `createToolGuard({ cloud: { connection } })`. */
export async function connectCloud(
  attesterKeyPem: string, url: string, bundle: CloudEnrollmentBundle, fetchImpl?: typeof fetch,
): Promise<FrameworkConnection> {
  const attester = attesterFromPrivateKeyPem(attesterKeyPem);
  const result = await completeCloudEnrollment({ url, bundle, attester, fetch: fetchImpl });
  return { url, ...result };
}
