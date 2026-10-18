---
"@scopebond/policy-schema": minor
---

Add the rule-pack format, `scopebond:pack/v1`: signed data (never code) that carries command grammars, MCP profiles, `action_allowlist` rules and conformance vectors. `schema/pack.schema.json` is the closed schema, and the new `./pack` subpath exports `validatePack`, `packSigningInput` (Ed25519 over `scopebond:pack/v1` plus LF and the RFC 8785 canonical pack without its signature), `packRef` and `comparePackVersions`. `vectors/example-pack.json` is a public pack built from made-up tools and signed with a test-only key, and `vectors/pack-format.json` holds valid and invalid documents.
