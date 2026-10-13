// MCP server profiles: a known server's tool call is also described as the taxonomy action it performs, beside the
// `mcp.tool.call` it always was; any other server or tool maps exactly as before. Content (file bodies, SQL, message text,
// URL paths) is never recorded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { validateActionParams } from "@scopebond/policy-schema/registry";
import {
  deriveMcpOperations, mcpProfileOf, mapClaudeToolUse, mapCodexToolUse, mapCursorEvent, useDigestKey, classifyIntent, defaultRules,
} from "../dist/index.js";

useDigestKey("6b".repeat(32));
const CANARY = `canary-${randomBytes(8).toString("hex")}`;
const ops = (server, tool, args) => deriveMcpOperations(server, tool, args).map((o) => ({ t: o.action_type, ...o.params }));

test("a server is recognised by a word of its configured name", () => {
  assert.equal(mcpProfileOf("github"), "github");
  assert.equal(mcpProfileOf("plugin_github_github"), "github");
  assert.equal(mcpProfileOf("server-filesystem"), "filesystem");
  assert.equal(mcpProfileOf("postgres-prod"), "postgres");
  assert.equal(mcpProfileOf("playwright"), "browser");
  assert.equal(mcpProfileOf("githubber"), undefined, "a word that only contains a name is not that name");
  assert.equal(mcpProfileOf("notes"), undefined);
});

test("github: pull requests, pushes and file writes", () => {
  assert.deepEqual(ops("github", "create_pull_request", { owner: "acme", repo: "web", head: "agent/fix", base: "main", title: CANARY, body: CANARY }),
    [{ t: "pr.open", repo: "acme/web", base: "main", head: "agent/fix", via: "github", derived_from: "mcp.tool.call" }]);
  assert.deepEqual(ops("github", "merge_pull_request", { owner: "acme", repo: "web", pullNumber: 42 }),
    [{ t: "pr.merge", repo: "acme/web", via: "github", derived_from: "mcp.tool.call" }]);
  assert.deepEqual(ops("github", "push_files", { owner: "acme", repo: "web", branch: "main", message: CANARY, files: [{ path: "src/a.ts", content: CANARY }, { path: ".github/workflows/ci.yml", content: CANARY }] }), [
    { t: "git.push", repo: "acme/web", ref: "main", force: false, via: "github", derived_from: "mcp.tool.call" },
    { t: "file.write", path: "src/a.ts", repo: "acme/web", via: "github", derived_from: "mcp.tool.call" },
    { t: "file.write", path: ".github/workflows/ci.yml", repo: "acme/web", via: "github", derived_from: "mcp.tool.call" },
  ]);
  assert.deepEqual(ops("github", "create_or_update_file", { owner: "acme", repo: "web", path: "README.md", branch: "docs", content: CANARY }), [
    { t: "file.write", path: "README.md", repo: "acme/web", via: "github", derived_from: "mcp.tool.call" },
    { t: "git.push", repo: "acme/web", ref: "docs", force: false, via: "github", derived_from: "mcp.tool.call" },
  ]);
  assert.deepEqual(ops("github", "delete_file", { owner: "acme", repo: "web", path: "old.txt", branch: "main" }), [
    { t: "file.write", path: "old.txt", repo: "acme/web", delete: true, via: "github", derived_from: "mcp.tool.call" },
    { t: "git.push", repo: "acme/web", ref: "main", force: false, via: "github", derived_from: "mcp.tool.call" },
  ]);
  assert.deepEqual(ops("github", "get_file_contents", { owner: "acme", repo: "web", path: "x" }), [], "reads are not described");
  assert.deepEqual(ops("github", "create_pull_request", { owner: "acme", title: "x" }), [], "no repository, no pull request");
});

test("filesystem: reads and writes by path", () => {
  assert.deepEqual(ops("filesystem", "write_file", { path: "/work/app/.env", content: CANARY }), [{ t: "file.write", path: "/work/app/.env", via: "filesystem", derived_from: "mcp.tool.call" }]);
  assert.deepEqual(ops("filesystem", "read_multiple_files", { paths: ["a.txt", "b.txt", 3] }).map((o) => o.path), ["a.txt", "b.txt"]);
  assert.deepEqual(ops("filesystem", "move_file", { source: "a", destination: "b" }).map((o) => [o.t, o.path]), [["file.write", "a"], ["file.write", "b"]]);
  assert.deepEqual(ops("filesystem", "list_allowed_directories", {}), []);
});

test("databases: SQL is classified, never recorded", () => {
  const [del] = ops("postgres", "query", { sql: `DELETE FROM sessions -- ${CANARY}` });
  assert.deepEqual(del, { t: "db.exec", provider: "postgres", verb: "delete_all", scope: "unknown", risk: "destructive", predicate_class: "all", via: "postgres", derived_from: "mcp.tool.call" });
  const [read] = ops("sqlite", "read_query", { query: "SELECT id FROM users WHERE id = 1" });
  assert.equal(read.risk, "ordinary");
  assert.equal(read.verb, "read");
  const [unknown] = ops("mysql", "execute_sql", { sql: "CALL do_things()" });
  assert.equal(unknown.risk, "unknown", "SQL the classifier cannot place is unknown, never ordinary");
  assert.deepEqual(ops("postgres", "list_tables", {}), []);
});

test("slack, browsers, fetch and trackers", () => {
  const [msg] = ops("slack", "slack_post_message", { channel_id: "C0123", text: CANARY });
  assert.equal(msg.t, "communication.send");
  assert.match(msg.channel_digest, /^hmac-sha256:[0-9a-f]{64}$/);
  assert.deepEqual(ops("playwright", "browser_navigate", { url: `https://shop.example/cart?token=${CANARY}` }), [{ t: "net.fetch", host: "shop.example", method: "GET", via: "browser", derived_from: "mcp.tool.call" }]);
  assert.deepEqual(ops("fetch", "fetch", { url: "https://docs.example/x" }), [{ t: "net.fetch", host: "docs.example", method: "GET", via: "fetch", derived_from: "mcp.tool.call" }]);
  assert.deepEqual(ops("fetch", "fetch", { url: "file:///etc/passwd" }), [], "only http and https");
  const [issue] = ops("linear", "create_issue", { team: "ENG", title: CANARY });
  assert.equal(issue.t, "work.item.create");
  assert.match(issue.project_digest, /^hmac-sha256:/);
  assert.equal(ops("atlassian", "editJiraIssue", { issueIdOrKey: "OPS-1" })[0].t, "work.item.update");
});

test("every derived MCP action is a valid taxonomy action and carries no content", () => {
  const calls = [
    ["github", "push_files", { owner: "acme", repo: "web", branch: "main", files: [{ path: "a", content: CANARY }] }],
    ["filesystem", "edit_file", { path: "a", edits: [{ oldText: CANARY, newText: CANARY }] }],
    ["postgres", "query", { sql: `UPDATE t SET x = '${CANARY}'` }],
    ["slack", "post_message", { channel: "C1", text: CANARY }],
    ["puppeteer", "puppeteer_navigate", { url: `https://a.example/${CANARY}` }],
    ["jira", "createJiraIssue", { projectKey: "OPS", summary: CANARY }],
  ];
  for (const [server, tool, args] of calls) {
    const out = deriveMcpOperations(server, tool, args);
    assert.ok(out.length > 0, `${server}/${tool}`);
    for (const op of out) {
      const v = validateActionParams(op.action_type, op.params);
      assert.ok(v.known && v.valid, `${op.action_type}: ${v.errors.join("; ")}`);
    }
    assert.ok(!JSON.stringify(out).includes(CANARY), `${server}/${tool} leaked content`);
  }
});

test("unknown servers and tools map exactly as before", () => {
  for (const name of ["mcp__notes__add", "mcp__github__get_me", "mcp__filesystem__list_allowed_directories"]) {
    const mapped = mapClaudeToolUse({ tool_name: name, tool_input: { a: 1 } });
    assert.deepEqual(mapped.map((m) => m.intent.action_type), ["mcp.tool.call"], name);
  }
});

test("Claude Code, Codex and Cursor derive the same actions from one MCP call, paths resolved against the working folder", () => {
  const args = { path: "/work/app/.scopebond/policy.json", content: CANARY };
  const claude = mapClaudeToolUse({ tool_name: "mcp__filesystem__write_file", tool_input: args, cwd: "/work/app" });
  const codex = mapCodexToolUse({ tool_name: "mcp__filesystem__write_file", tool_input: args, cwd: "/work/app" });
  // Cursor's own payload: the server's configured name, the arguments as JSON text, the launch command, and no cwd.
  const cursor = mapCursorEvent("beforeMCPExecution", {
    hook_event_name: "beforeMCPExecution", mcp_server_name: "filesystem", tool_name: "write_file", tool_input: JSON.stringify(args),
    command: "npx -y @modelcontextprotocol/server-filesystem /work/app", workspace_roots: ["/work/app"],
  });
  for (const mapped of [claude, codex, cursor]) {
    assert.deepEqual(mapped.map((m) => m.intent.action_type), ["mcp.tool.call", "file.write"]);
    assert.equal(mapped[1].intent.params.path, ".scopebond/policy.json");
    assert.equal(mapped[1].derived, true);
    assert.equal(mapped[0].derived, undefined);
  }
  // Writing Scopebond's own folder through an MCP server is the guardrail modification it is through any other tool.
  assert.deepEqual(classifyIntent(claude[1].intent, defaultRules()).ids, ["C02"]);
});

test("a push to a protected branch through the GitHub MCP server is classified as one", () => {
  const mapped = mapClaudeToolUse({ tool_name: "mcp__github__push_files", tool_input: { owner: "acme", repo: "web", branch: "main", files: [{ path: "a.ts", content: "x" }] } });
  const push = mapped.find((m) => m.intent.action_type === "git.push");
  assert.deepEqual(classifyIntent(push.intent, defaultRules()).ids, ["H01"]);
});

test("Cursor: the arguments come from tool_input, and the server's URL or launch command names it when its configured name does not", () => {
  const input = { owner: "acme", repo: "web", branch: "main", files: [{ path: "a.ts", content: CANARY }] };
  const types = (payload) => mapCursorEvent("beforeMCPExecution", payload).map((m) => m.intent.action_type);
  // An HTTP server configured under a name of the person's choosing.
  assert.deepEqual(types({ mcp_server_name: "gh-remote", tool_name: "push_files", tool_input: JSON.stringify(input), url: "https://api.githubcopilot.com/mcp/", mcp_server_url: "https://api.githubcopilot.com/mcp/", workspace_roots: ["/w"] }),
    ["mcp.tool.call", "git.push", "file.write"]);
  // A stdio server: its launch command.
  assert.deepEqual(types({ mcp_server_name: "code-host", tool_name: "push_files", tool_input: JSON.stringify(input), command: "docker run -i --rm ghcr.io/github/github-mcp-server", workspace_roots: ["/w"] }),
    ["mcp.tool.call", "git.push", "file.write"]);
  // A server neither names stays the plain call.
  assert.deepEqual(types({ mcp_server_name: "notes", tool_name: "push_files", tool_input: JSON.stringify(input), command: "node notes.js" }), ["mcp.tool.call"]);
  const [call] = mapCursorEvent("beforeMCPExecution", { mcp_server_name: "gh-remote", tool_name: "push_files", tool_input: JSON.stringify(input), url: "https://api.githubcopilot.com/mcp/" });
  assert.equal(call.intent.params.server, "gh-remote", "the call records the configured name");
  assert.equal(call.intent.params.tool, "push_files");
  assert.ok(!JSON.stringify(mapCursorEvent("beforeMCPExecution", { mcp_server_name: "github", tool_name: "push_files", tool_input: JSON.stringify(input) })).includes(CANARY));
  // A path is resolved against the first workspace folder (beforeMCPExecution carries no cwd).
  const write = mapCursorEvent("beforeMCPExecution", { mcp_server_name: "filesystem", tool_name: "write_file", tool_input: JSON.stringify({ path: "/w/src/a.ts", content: "x" }), workspace_roots: ["/w"] });
  assert.equal(write[1].intent.params.path, "src/a.ts");
  // Unreadable arguments: only the call.
  assert.deepEqual(types({ mcp_server_name: "github", tool_name: "push_files", tool_input: "{not json" }), ["mcp.tool.call"]);
});
