// The pipe client against a Node HTTP server on a named pipe, the way the agent serves its local channel (Windows only;
// skipped where Node is not installed). The server writes an endpoint file shaped like the agent's.
#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use scopebond_tray::agent::{AgentClient, CallError};
use scopebond_tray::model::Notifications;

const SERVER: &str = r#"
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const home = process.argv[2];
const token = crypto.randomBytes(24).toString("base64url");
const pipe = "\\\\.\\pipe\\scopebond-tray-test-" + crypto.randomBytes(8).toString("hex");
const server = http.createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
  if (req.headers["x-scopebond-agent-token"] !== token) return send(401, { error: "unauthorized" });
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const route = `${req.method} ${req.url}`;
  if (route === "GET /tray") return send(200, {
    tray: { state: "attention", headline: "3 records waiting to send · café", tooltip: "Scopebond — 3 waiting", rows: [{ label: "Delivery", value: "3 waiting · sending" }],
      fix: { id: "send_now", label: "Send records now", route: "/flush" }, actions: [{ id: "check_now", label: "Check now", route: "/check" }], hint: null, recent_blocks: [] },
    settings: { notifications: "all" },
  });
  if (route === "POST /settings") return send(200, { settings: JSON.parse(raw) });
  if (route === "GET /slow") return setTimeout(() => send(200, { late: true }), 4000);
  if (route === "GET /big") { res.writeHead(200, { "content-type": "application/json" }); res.write("["); for (let i = 0; i < 2000; i++) res.write((i ? "," : "") + JSON.stringify("x".repeat(100) + i)); return res.end("]"); }
  send(404, { error: "not found" });
});
server.listen(pipe, () => {
  fs.writeFileSync(path.join(home, "agent.json"), JSON.stringify({ port: 0, socket: pipe, token, pid: process.pid, started_at: Date.now(), version: "test" }));
});
setTimeout(() => process.exit(0), 120000);
"#;

struct Server {
    child: Child,
    home: PathBuf,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

fn start(name: &str) -> Option<Server> {
    if Command::new("node").arg("--version").stdout(Stdio::null()).status().map(|s| !s.success()).unwrap_or(true) {
        eprintln!("node is not installed: skipped");
        return None;
    }
    let home = std::env::temp_dir().join(format!("scopebond-tray-pipe-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let script = home.join("server.js");
    std::fs::write(&script, SERVER).unwrap();
    let child = Command::new("node").arg(&script).arg(&home).stdout(Stdio::null()).spawn().unwrap();
    let server = Server { child, home };
    let until = Instant::now() + Duration::from_secs(15);
    while !server.home.join("agent.json").exists() {
        assert!(Instant::now() < until, "the test server did not start");
        std::thread::sleep(Duration::from_millis(100));
    }
    Some(server)
}

fn copy_endpoint_with_token(from: &Path, to: &Path, token: &str) {
    std::fs::create_dir_all(to).unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&std::fs::read(from.join("agent.json")).unwrap()).unwrap();
    value["token"] = serde_json::Value::String(token.into());
    std::fs::write(to.join("agent.json"), serde_json::to_vec(&value).unwrap()).unwrap();
}

#[test]
fn reads_the_tray_model_over_the_pipe() {
    let Some(server) = start("model") else { return };
    let client = AgentClient::new(server.home.clone());
    assert!(client.answers());
    let answer = client.tray().expect("a tray model");
    assert_eq!(answer.tray.state, "attention");
    assert_eq!(answer.tray.headline, "3 records waiting to send · café", "UTF-8 reads as written");
    assert_eq!(answer.tray.fix.as_ref().map(|f| f.route.as_str()), Some("/flush"));
    assert_eq!(answer.settings.notifications, Notifications::All);
}

#[test]
fn posts_a_body_and_reads_a_long_chunked_answer() {
    let Some(server) = start("post") else { return };
    let client = AgentClient::new(server.home.clone());
    let answer = client.call("POST", "/settings", Some(&serde_json::json!({ "notifications": "off" })), Duration::from_secs(5)).unwrap();
    assert_eq!(answer["settings"]["notifications"], "off");
    let big = client.call("GET", "/big", None, Duration::from_secs(10)).unwrap();
    assert_eq!(big.as_array().map(|a| a.len()), Some(2000));
}

#[test]
fn many_calls_at_once_all_get_answers() {
    let Some(server) = start("busy") else { return };
    let handles: Vec<_> = (0..12)
        .map(|_| {
            let client = AgentClient::new(server.home.clone());
            std::thread::spawn(move || client.tray().is_some())
        })
        .collect();
    for h in handles {
        assert!(h.join().unwrap());
    }
}

#[test]
fn a_wrong_token_is_refused_and_a_slow_answer_times_out() {
    let Some(server) = start("refused") else { return };
    let other = server.home.join("other");
    copy_endpoint_with_token(&server.home, &other, "not-the-token");
    assert_eq!(AgentClient::new(other).call("GET", "/tray", None, Duration::from_secs(5)), Err(CallError::Refused(401)));
    let client = AgentClient::new(server.home.clone());
    let started = Instant::now();
    assert_eq!(client.call("GET", "/slow", None, Duration::from_millis(800)), Err(CallError::Timeout));
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(client.call("GET", "/nothing", None, Duration::from_secs(5)), Err(CallError::Refused(404)));
}

#[test]
fn after_the_agent_exits_nothing_answers() {
    let Some(mut server) = start("gone") else { return };
    let client = AgentClient::new(server.home.clone());
    assert!(client.answers());
    server.child.kill().unwrap();
    let _ = server.child.wait();
    let until = Instant::now() + Duration::from_secs(5);
    while client.answers() {
        assert!(Instant::now() < until, "the pipe outlived its server");
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(matches!(client.call("GET", "/tray", None, Duration::from_secs(2)), Err(CallError::NotAnswering(_))));
}
