// Test helper: an in-process upstream that also answers `tools/list` with the given tool names. The proxy forwards a
// `tools/call` only under a name that is exactly one of the upstream's listed tools, so a stub upstream lists the
// tools its tests call. The listing is answered here and never reaches the wrapped upstream's own `call`.
export function listed(upstream, names) {
  const tools = names.map((name) => ({ name }));
  return {
    ...upstream,
    call: async (m) => (m?.method === "tools/list" ? { jsonrpc: "2.0", id: m.id ?? null, result: { tools } } : upstream.call(m)),
  };
}
