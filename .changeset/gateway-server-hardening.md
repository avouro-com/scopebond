---
"@scopebond/verify": patch
"@scopebond/gateway": patch
---

Self-hosted gateway hardening.

- **HTTP executor:** an allowed `http.call` now reaches only the host its policy checked. The executor builds the URL with `new URL`, requires a path that starts with a single `/`, and checks the parsed host again. Before, a path such as `@other.example/x` sent the call to another host.
- **Host lists:** `endpoint_allowlist` and `endpoint_denylist` compare hosts as an HTTP client resolves them, ignoring case and one trailing dot. A host that is not a bare name or address, or a path that does not start with `/`, is never allowed and counts as denied.
- **Request bodies:** every request body is limited to 1 MiB (`maxBodyBytes`) before it is read, and JSON nested deeper than 64 levels is refused. MCP errors no longer echo internal exception text.
- **File access:** key files, the receipt database and the JSONL logs are readable by their owner alone. On Windows the inherited access list is replaced with the current user and SYSTEM; on POSIX the mode is 0600.
- **Anchor proofs:** leaf hashes are computed once instead of on every request. A lookup by `intent_hash` needs the control token; a lookup by leaf hash stays public.
