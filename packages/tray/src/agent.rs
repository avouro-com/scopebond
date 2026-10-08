//! Talking to the Scopebond Agent: find its endpoint file in the Scopebond home, connect to its named pipe, send one
//! request with its token, read the answer. The same requests the agent's own clients (the CLI, the hook's override
//! window) send. The pipe's name changes with every start of the agent, so the file is read again for every call.

use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::http::{self, MAX_ANSWER};
use crate::model::TrayAnswer;

pub const AGENT_FILE: &str = "agent.json";

/// What the agent writes to `agent.json` when it starts. `socket` is the named pipe (the Unix socket elsewhere).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Endpoint {
    #[serde(default)]
    pub socket: Option<String>,
    pub token: String,
    #[serde(default)]
    pub pid: u32,
    #[serde(default)]
    pub version: String,
}

impl Endpoint {
    pub fn parse(json: &[u8]) -> Option<Endpoint> {
        serde_json::from_slice::<Endpoint>(json).ok().filter(|e| !e.token.is_empty())
    }

    /// The pipe or socket, when the agent made one.
    pub fn channel(&self) -> Option<&str> {
        self.socket.as_deref().filter(|s| !s.is_empty())
    }
}

/// The Scopebond home: `SCOPEBOND_HOME`, else `.scopebond` in the person's profile (as the agent decides it).
pub fn scopebond_home_from(env: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(home) = env("SCOPEBOND_HOME").filter(|h| !h.is_empty()) {
        return Some(PathBuf::from(home));
    }
    let profile = if cfg!(windows) { env("USERPROFILE") } else { env("HOME") };
    profile.filter(|p| !p.is_empty()).map(|p| Path::new(&p).join(".scopebond"))
}

pub fn scopebond_home() -> Option<PathBuf> {
    scopebond_home_from(|k| std::env::var(k).ok())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallError {
    /// No endpoint file, or one without a pipe: no agent has started (or it predates the pipe).
    NoEndpoint,
    /// The pipe is not there or refused the connection: the agent is not running.
    NotAnswering(String),
    Timeout,
    /// The agent answered with this status (401 when the token is not its own).
    Refused(u16),
    BadAnswer(String),
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallError::NoEndpoint => write!(f, "the Scopebond Agent has not started"),
            CallError::NotAnswering(why) => write!(f, "the Scopebond Agent is not answering ({why})"),
            CallError::Timeout => write!(f, "the Scopebond Agent did not answer in time"),
            CallError::Refused(status) => write!(f, "the Scopebond Agent refused the request (HTTP {status})"),
            CallError::BadAnswer(why) => write!(f, "the Scopebond Agent's answer could not be read ({why})"),
        }
    }
}

#[cfg(windows)]
fn connect(channel: &str, deadline: Instant) -> std::io::Result<fs::File> {
    // ERROR_PIPE_BUSY: every instance is serving someone; the agent makes another, so try again shortly.
    const ERROR_PIPE_BUSY: i32 = 231;
    loop {
        match fs::OpenOptions::new().read(true).write(true).open(channel) {
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(50))
            }
            other => return other,
        }
    }
}

#[cfg(unix)]
fn connect(channel: &str, _deadline: Instant) -> std::io::Result<std::os::unix::net::UnixStream> {
    std::os::unix::net::UnixStream::connect(channel)
}

fn exchange(channel: &str, request: &[u8], deadline: Instant) -> Result<Vec<u8>, CallError> {
    let mut stream = connect(channel, deadline).map_err(|e| CallError::NotAnswering(e.kind().to_string()))?;
    stream.write_all(request).map_err(|e| CallError::NotAnswering(e.kind().to_string()))?;
    let _ = stream.flush();
    let mut out = Vec::new();
    let mut buf = [0u8; 16 * 1024];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                out.extend_from_slice(&buf[..n]);
                if out.len() > MAX_ANSWER {
                    return Err(CallError::BadAnswer("too large".into()));
                }
            }
            // The agent closed its end after answering.
            Err(e) if e.kind() == ErrorKind::BrokenPipe || e.raw_os_error() == Some(109) => break,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(CallError::BadAnswer(e.kind().to_string())),
        }
    }
    Ok(out)
}

/// The agent of one Scopebond home.
#[derive(Debug, Clone)]
pub struct AgentClient {
    home: PathBuf,
}

impl AgentClient {
    pub fn new(home: PathBuf) -> AgentClient {
        AgentClient { home }
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    pub fn endpoint(&self) -> Option<Endpoint> {
        Endpoint::parse(&fs::read(self.home.join(AGENT_FILE)).ok()?)
    }

    /// Whether something accepts a connection on the agent's pipe now (no request is sent).
    pub fn answers(&self) -> bool {
        let Some(endpoint) = self.endpoint() else { return false };
        let Some(channel) = endpoint.channel() else { return false };
        connect(channel, Instant::now() + Duration::from_millis(500)).is_ok()
    }

    /// One request; the JSON answer, or why there is none. The call runs on its own thread, so a stuck agent costs a
    /// thread until the agent lets go, never the caller's time.
    pub fn call(&self, method: &str, path: &str, body: Option<&serde_json::Value>, timeout: Duration) -> Result<serde_json::Value, CallError> {
        let endpoint = self.endpoint().ok_or(CallError::NoEndpoint)?;
        let channel = endpoint.channel().ok_or(CallError::NoEndpoint)?.to_string();
        let body = body.map(|b| serde_json::to_vec(b).unwrap_or_default());
        let request = http::request(method, path, &endpoint.token, body.as_deref());
        let deadline = Instant::now() + timeout;
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let _ = tx.send(exchange(&channel, &request, deadline));
        });
        let raw = rx.recv_timeout(timeout).map_err(|_| CallError::Timeout)??;
        let (status, body) = http::parse_response(&raw).map_err(|e| CallError::BadAnswer(e.to_string()))?;
        if !(200..300).contains(&status) {
            return Err(CallError::Refused(status));
        }
        serde_json::from_slice(&body).map_err(|e| CallError::BadAnswer(e.to_string()))
    }

    /// The agent's tray model and the person's tray settings, or None when it does not answer.
    pub fn tray(&self) -> Option<TrayAnswer> {
        let value = self.call("GET", "/tray", None, Duration::from_secs(10)).ok()?;
        TrayAnswer::parse(&serde_json::to_vec(&value).ok()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_agents_endpoint_file() {
        let e = Endpoint::parse(br#"{"port":0,"socket":"\\\\.\\pipe\\scopebond-agent-0123","token":"abc","pid":42,"started_at":1,"version":"agent/0.5.1 hook/0.21.0"}"#).unwrap();
        assert_eq!(e.channel(), Some(r"\\.\pipe\scopebond-agent-0123"));
        assert_eq!(e.pid, 42);
        let without_pipe = Endpoint::parse(br#"{"port":5000,"socket":null,"token":"abc","pid":1}"#).unwrap();
        assert_eq!(without_pipe.channel(), None, "a loopback-only agent is not one the tray talks to");
        assert!(Endpoint::parse(br#"{"socket":"x","token":""}"#).is_none());
        assert!(Endpoint::parse(b"{").is_none());
    }

    #[test]
    fn the_home_is_scopebond_home_or_the_profiles_folder() {
        let env = |pairs: &'static [(&'static str, &'static str)]| move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string());
        assert_eq!(scopebond_home_from(env(&[("SCOPEBOND_HOME", "D:\\sb"), ("USERPROFILE", "C:\\p"), ("HOME", "/h")])), Some(PathBuf::from("D:\\sb")));
        let profile = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let found = scopebond_home_from(|k: &str| (k == profile).then(|| "P".to_string()));
        assert_eq!(found, Some(Path::new("P").join(".scopebond")));
        assert_eq!(scopebond_home_from(|_: &str| None), None);
    }

    #[test]
    fn without_an_endpoint_file_nothing_answers() {
        let home = std::env::temp_dir().join(format!("scopebond-tray-test-{}", std::process::id()));
        let client = AgentClient::new(home.clone());
        assert!(!client.answers());
        assert_eq!(client.call("GET", "/tray", None, Duration::from_secs(1)), Err(CallError::NoEndpoint));
        assert!(client.tray().is_none());
    }
}
