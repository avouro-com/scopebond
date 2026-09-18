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
  const mapped = mapClaudeToolUse(payload);
  const signed = agent.sign(mapped.intent);
  let decision, reason;
  if (!mapped.evaluated) {
    // No taxonomy type applies: the runtime observes without evaluating — grants
    // nothing (never a silent allow).
    decision = "not_evaluated";
    reason = `no policy applies to ${mapped.intent.action_type}`;
  } else {
    const res = await gateway.handleAction(signed);
    decision = res.allowed ? "allow" : "deny";
    reason = res.reason;
  }
  console.log(`\n${label}`);
  console.log(`  ${payload.tool_name} → ${mapped.intent.action_type} ${JSON.stringify(mapped.intent.params)}`);
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
