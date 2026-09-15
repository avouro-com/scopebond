# @scopebond/gateway

## 0.4.1

### Patch Changes

- b434d38: Add a bounded CLI enrollment flow that proves possession of the gateway attester key and returns scoped Cloud exporter configuration only to the gateway terminal.

## 0.4.0

### Minor Changes

- 2dabf5f: Publish the authenticated evidence SDK and add scoped-machine Cloud export with a
  bounded durable SQLite outbox, duplicate-safe acknowledgement, retry backoff and
  explicit delivery-gap status.

### Patch Changes

- Updated dependencies [875d640]
  - @scopebond/policy-schema@0.2.0
  - @scopebond/verify@0.1.1
