---
"@scopebond/gateway": patch
---

The HTTP executor now connects to the addresses its endpoint_denylist check approved. When an enforced denylist lists an address, a host name is resolved and checked before the call; the request is then sent to those checked addresses without resolving the name again, so a resolver that answers the check with an allowed address and the connection with a denied one (DNS rebinding) cannot send the call to the denied address. The request still names the host, so the Host header and, for HTTPS, the server name and certificate check are for the name. A redirect answer is an error, as before. An injected `fetch` is the caller's own transport and resolves names itself.
