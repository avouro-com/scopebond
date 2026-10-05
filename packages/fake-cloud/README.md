# @scopebond/fake-cloud

**Free, open-source test tool (Apache-2.0).** A stand-in for a Scopebond workspace, for testing
anything that connects a computer or an agent to one: the device-code sign-in, enrollment, record
delivery, observations, managed rules, the self-check and the client-version route, with a
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
cloud.state();                                        // codes, enrollments, deliveries, self-checks, faults applied
await cloud.close();
```

Routes that take faults: `device/code`, `device/token`, `enroll`, `ingest`, `observations`,
`policy`, `self-check`, `client-version`. A credential is issued by `enroll` and bound to the
enrolling key's id, as the workspace does; deliveries with any other credential get 401.

## As a process

```bash
npx -y @scopebond/fake-cloud --url-file cloud-url.txt --auto-approve --fault ingest=500x2
```

`--fault` takes `<route>=<status>[xN]`, `<route>=slow:<ms>` or `<route>=drop`. In Windows
PowerShell, type `npx.cmd`. The test-only routes `POST /__test/approve` and `GET /__test/state`
do what `approve()` and `state()` do.
