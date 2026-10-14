# @scopebond/fake-cloud

**Free, open-source test tool (Apache-2.0).** A stand-in for a Scopebond workspace, for testing
anything that connects a computer or an agent to one: the device-code sign-in, enrollment, record
delivery, summaries, observations, managed rules, the self-check, the uninstall notice and the
client-version route, with a
control surface for tests and fault injection. It has no dependencies beyond Node.js and keeps
everything in memory.

It is not the Scopebond Cloud and implements none of its policy, review or storage; it answers
the way the real routes answer so clients can be tested without one.

## In a test

```js
import { startFakeCloud } from "@scopebond/fake-cloud";

const cloud = await startFakeCloud();                 // { autoApprove: true } approves codes itself
// … run `login <cloud.url>` and read the code it prints …
cloud.approve(userCode);                              // as a person would on the approval page
cloud.fault("ingest", { status: 429, code: "rate_limited", times: 1 });
cloud.fault("ingest", { delayMs: 3000 });             // a slow workspace
cloud.fault("ingest", { drop: true, times: 1 });      // a connection closed with no answer
cloud.setUninstallAuthorized(true);                   // the uninstall notice answers authorized: true
cloud.state();                                        // codes, enrollments, deliveries, summaries, uninstall notices, self-checks, faults applied
await cloud.close();
```

Routes that take faults: `device/code`, `device/token`, `enroll`, `ingest`, `summaries`, `observations`,
`policy`, `self-check`, `uninstall`, `client-version`. A credential is issued by `enroll` and bound to the
enrolling key's id, as the workspace does; deliveries with any other credential get 401.

`summaries` and `uninstall` follow the workspace's routes:

- `POST /v1/summaries` checks each summary's shape as the workspace does (summary id of 16 to 200
  characters, counts adding up to `receipt_count`, record numbers in `seq` accounting for exactly
  `receipt_count`, a window not ending in the future; the signature is not verified). A bad summary
  is refused on its own: the answer is 200 `{ ok: true, accepted, duplicates, actions, rejected:
  [{ index, summary_id, reason }] }`, where `actions` is the number of records the newly held
  summaries stand for. Only when every summary was refused is it 400 `invalid_receipt` (with
  `rejected`); an unreadable body is 400 `bad_request`, more than 20 summaries or 1 MiB is 413
  `batch_too_large`, and an unknown credential is 401 `credential_refused`. Each refusal carries
  `error`, `code` and `remediation`.
- `POST /v1/uninstall` records whatever it is sent (never 400) and answers `{ authorized }` only.

## As a process

```bash
pnpm -r build
node packages/fake-cloud/dist/cli.js --url-file cloud-url.txt --auto-approve --fault ingest=500x2
```

`--fault` takes `<route>=<status>[xN]`, `<route>=slow:<ms>` or `<route>=drop`. In Windows
PowerShell, type `npx.cmd`. The test-only routes `POST /__test/approve` and `GET /__test/state`
do what `approve()` and `state()` do.
