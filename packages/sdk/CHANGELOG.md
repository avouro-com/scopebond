# @scopebond/sdk

## 0.1.12

### Patch Changes

- 846c95c: Package descriptions and READMEs use one vocabulary (Monitor or Block rules, signed records, protection packs) and list GitHub Copilot with the other supported coding tools. The SDK README's example now signs a coding-agent `shell.exec` action. No code changes.
- Updated dependencies [846c95c]
  - @scopebond/policy-schema@0.11.4

## 0.1.11

### Patch Changes

- Updated dependencies [40270e7]
  - @scopebond/policy-schema@0.11.0

## 0.1.10

### Patch Changes

- Updated dependencies [e4ba261]
  - @scopebond/policy-schema@0.10.0

## 0.1.9

### Patch Changes

- Updated dependencies [a71186a]
- Updated dependencies [1af329c]
  - @scopebond/policy-schema@0.9.0

## 0.1.8

### Patch Changes

- Updated dependencies [d401d09]
- Updated dependencies [9c70fd6]
- Updated dependencies [6797bbd]
- Updated dependencies [ad9512d]
  - @scopebond/policy-schema@0.8.0

## 0.1.7

### Patch Changes

- a17f73b: When the gateway answers without JSON, the error `submit()` throws now carries the parse error as its `cause`.

## 0.1.6

### Patch Changes

- 88a6380: `submit()` now fails closed: it rejects on a non-2xx answer that is not an explicit deny, on an answer without a boolean `allowed`, and after a timeout (default 10 s, set with the new `{ timeoutMs }` option).

## 0.1.5

### Patch Changes

- Updated dependencies [cb4d4e0]
- Updated dependencies [e0f2de4]
- Updated dependencies [c877e45]
  - @scopebond/policy-schema@0.7.0

## 0.1.4

### Patch Changes

- Updated dependencies [433c8df]
  - @scopebond/policy-schema@0.6.0

## 0.1.3

### Patch Changes

- Updated dependencies [b08c8df]
- Updated dependencies [aac4f6f]
  - @scopebond/policy-schema@0.5.0

## 0.1.2

### Patch Changes

- Updated dependencies [f212f82]
  - @scopebond/policy-schema@0.4.0

## 0.1.1

### Patch Changes

- Updated dependencies [ed6a822]
- Updated dependencies [27be98a]
- Updated dependencies [973507f]
- Updated dependencies [6417866]
- Updated dependencies [8ad0aab]
- Updated dependencies [1260a51]
  - @scopebond/policy-schema@0.3.0

## 0.1.0

### Minor Changes

- 2dabf5f: Publish the authenticated evidence SDK and add scoped-machine Cloud export with a
  bounded durable SQLite outbox, duplicate-safe acknowledgement, retry backoff and
  explicit delivery-gap status.

### Patch Changes

- Updated dependencies [875d640]
  - @scopebond/policy-schema@0.2.0
