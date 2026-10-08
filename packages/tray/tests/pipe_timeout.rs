// A call to an agent that accepts the connection and never answers ends at its timeout and leaves nothing behind: no
// thread, no pipe handle, no I/O in flight. Its own test program, so no other test's handles move the count (Windows only;
// skipped where Node is not installed).
#![cfg(windows)]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use scopebond_tray::agent::{AgentClient, CallError};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessHandleCount};

const SERVER: &str = r#"
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const home = process.argv[2];
const token = crypto.randomBytes(24).toString("base64url");
const pipe = "\\\\.\\pipe\\scopebond-tray-hang-" + crypto.randomBytes(8).toString("hex");
const server = http.createServer((req, res) => {
  // Accepts every request, reads it, and answers only GET /ping.
  req.resume();
  if (req.url === "/ping") { res.writeHead(200, { "content-type": "application/json" }); res.end("{\"ok\":true}"); }
});
server.requestTimeout = 0;
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

fn handles() -> u32 {
    let mut count = 0u32;
    // SAFETY: this process's pseudo-handle, and a place for the count.
    unsafe {
        GetProcessHandleCount(GetCurrentProcess(), &mut count);
    }
    count
}

#[test]
fn a_call_to_an_agent_that_never_answers_ends_at_its_timeout_and_leaves_no_handle_behind() {
    if Command::new("node").arg("--version").stdout(Stdio::null()).status().map(|s| !s.success()).unwrap_or(true) {
        eprintln!("node is not installed: skipped");
        return;
    }
    let home = std::env::temp_dir().join(format!("scopebond-tray-hang-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(home.join("server.js"), SERVER).unwrap();
    let child = Command::new("node").arg(home.join("server.js")).arg(&home).stdout(Stdio::null()).spawn().unwrap();
    let server = Server { child, home };
    let until = Instant::now() + Duration::from_secs(15);
    while !server.home.join("agent.json").exists() {
        assert!(Instant::now() < until, "the test server did not start");
        std::thread::sleep(Duration::from_millis(100));
    }
    let client = AgentClient::new(server.home.clone());
    assert!(client.call("GET", "/ping", None, Duration::from_secs(5)).is_ok());
    assert_eq!(client.call("GET", "/hang", None, Duration::from_millis(300)), Err(CallError::Timeout));
    let before = handles();
    for _ in 0..40 {
        let started = Instant::now();
        assert_eq!(client.call("GET", "/hang", None, Duration::from_millis(200)), Err(CallError::Timeout));
        assert!(started.elapsed() < Duration::from_secs(2), "the call outlived its timeout: {:?}", started.elapsed());
    }
    // The agent's other answers still come, and the forty calls that timed out left no handle open.
    assert!(client.call("GET", "/ping", None, Duration::from_secs(5)).is_ok());
    let after = handles();
    assert!(after <= before + 8, "{before} handles before forty calls that timed out, {after} after");
}
