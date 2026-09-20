// Claude Code / Cursor connector: map a coding agent's native tool call to a
// normalized taxonomy action, then decide it against policy (cooperative M0). The
// mapper (`mapClaudeToolUse`) is the connector's deterministic core; here each
// mapped intent is checked through a gateway in check-only mode, exactly as the
// `scopebond-hook` runtime does. Run: `pnpm -r build && node examples/hook-map.mjs`
import { mapClaudeToolUse, starterPolicy } from "@scopebond/hook";
import { createGateway, StaticPrincipalKeyRegistry } from "@scopebond/gateway";
import { createSigner } from "@scopebond/sdk";

const agent = createSigner();
const keys = new StaticPrincipalKeyRegistry([
  { kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active" },
]);
// The default coding-agent policy: protect main/master/release, deny destructive
// programs (rm, sudo, …), allow workspace file access.
const gateway = createGateway({ policy: starterPolicy(agent.kid), authentication: { keys }, mode: "check_only" });

async function hook(label, payload) {
  // A shell tool call can carry several commands (`a && b`, `bash -c '…'`), so the
  // mapper returns one intent per simple command. Decide every one and deny the
  // call if any is out of policy.
  const mapped = mapClaudeToolUse(payload);
  const lines = [];
  let decision = "not_evaluated";
  let reason = "no policy applies";
  for (const m of mapped) {
    lines.push(`${m.intent.action_type} ${JSON.stringify(m.intent.params)}`);
    if (!m.evaluated) continue; // no taxonomy type: observed, grants nothing
    const res = await gateway.handleAction(agent.sign(m.intent));
    if (!res.allowed) { decision = "deny"; reason = res.reason; break; }
    decision = "allow"; reason = res.reason;
  }
  console.log(`\n${label}`);
  console.log(`  ${payload.tool_name} → ${lines.join("  |  ")}`);
  console.log(`  decision = ${decision}  ·  ${reason}`);
}

await hook("Bash `git push origin main` (push to a protected branch → deny)",
  { tool_name: "Bash", tool_input: { command: "git push origin main" } });
await hook("Read a workspace file (allowed)",
  { tool_name: "Read", tool_input: { file_path: "/repo/src/app.ts" }, cwd: "/repo" });
await hook("Bash `rm -rf build` (destructive program → deny)",
  { tool_name: "Bash", tool_input: { command: "rm -rf build" } });
await hook("WebSearch (no taxonomy mapping → observed, not evaluated)",
  { tool_name: "WebSearch", tool_input: { query: "scopebond" } });
