---
"@scopebond/verify": patch
"@scopebond/gateway": patch
"@scopebond/policy-schema": patch
---

Endpoint allowlists and denylists now compare the destination a request reaches, not the text of its host: another spelling of a listed address (decimal, octal, hex, IPv6, IPv4-mapped IPv6), a port on a host listed without one, or another loopback address for a listed loopback host is denied. The HTTP executor also refuses a name that resolves to a denied address, and records a call it refuses before sending as failed.
