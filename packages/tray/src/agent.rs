//! Talking to the Scopebond Agent: find its endpoint file in the Scopebond home, connect to its named pipe, send one
//! request with its token, read the answer. The same requests the agent's own clients (the CLI, the hook's override
//! window) send. The pipe's name changes with every start of the agent, so the file is read again for every call.
//!
//! A call runs on the caller's thread and never outlives its timeout: on Windows the pipe is opened for overlapped I/O,
//! every read and write is waited for only until the call's deadline, and at the deadline the I/O is cancelled
//! (`CancelIoEx`) and its completion awaited before the handle is closed. An agent that accepts the connection and then
//! never answers costs the caller the timeout, and nothing after it: no thread, no handle, no I/O left in flight.

use std::fs;
use std::path::{Path, PathBuf};
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

/// How one read or write on the pipe ended, when it did not move bytes.
#[derive(Debug)]
enum Io {
    /// The agent closed its end (after answering).
    Closed,
    /// The call's deadline came first; the I/O was cancelled.
    Timeout,
    Failed(String),
}

#[cfg(windows)]
mod pipe {
    //! The client end of the agent's named pipe, with overlapped I/O that is cancelled at the call's deadline.

    use std::fs;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
    use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
    use windows_sys::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
    use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

    use super::Io;

    const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    const ERROR_BROKEN_PIPE: u32 = 109;
    /// Every instance of the pipe is serving someone; the agent makes another, so the tray tries again shortly.
    const ERROR_PIPE_BUSY: i32 = 231;
    const ERROR_PIPE_NOT_CONNECTED: u32 = 233;
    const ERROR_MORE_DATA: u32 = 234;
    const ERROR_IO_PENDING: u32 = 997;
    const WAIT_OBJECT_0: u32 = 0;

    /// Connect to the pipe, for overlapped I/O.
    pub fn connect(channel: &str, deadline: Instant) -> std::io::Result<fs::File> {
        loop {
            match fs::OpenOptions::new().read(true).write(true).custom_flags(FILE_FLAG_OVERLAPPED).open(channel) {
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                other => return other,
            }
        }
    }

    /// One connection, and the event its I/O signals. Dropping it closes both; no I/O is in flight by then.
    pub struct Pipe {
        file: fs::File,
        event: HANDLE,
    }

    impl Drop for Pipe {
        fn drop(&mut self) {
            // SAFETY: the event was made for this pipe by CreateEventW, and no I/O that signals it is in flight: every
            // transfer returns only once its I/O has finished, also when it was cancelled. The file closes itself.
            unsafe {
                CloseHandle(self.event);
            }
        }
    }

    impl Pipe {
        pub fn open(channel: &str, deadline: Instant) -> std::io::Result<Pipe> {
            let file = connect(channel, deadline)?;
            // SAFETY: default security, manual reset, not signalled, no name.
            let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
            if event.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            Ok(Pipe { file, event })
        }

        /// Write all of `data` before the deadline.
        pub fn write_all(&self, mut data: &[u8], deadline: Instant) -> Result<(), Io> {
            while !data.is_empty() {
                let len = data.len().min(64 * 1024) as u32;
                let n = self.transfer(data.as_ptr().cast_mut(), len, true, deadline)? as usize;
                if n == 0 {
                    return Err(Io::Failed("nothing was written".into()));
                }
                data = &data[n.min(data.len())..];
            }
            Ok(())
        }

        /// Read what the agent sent next (0 or `Io::Closed` when it closed its end), before the deadline.
        pub fn read(&self, buf: &mut [u8], deadline: Instant) -> Result<usize, Io> {
            let len = buf.len().min(1024 * 1024) as u32;
            self.transfer(buf.as_mut_ptr(), len, false, deadline).map(|n| n as usize)
        }

        fn transfer(&self, data: *mut u8, len: u32, write: bool, deadline: Instant) -> Result<u32, Io> {
            let handle = self.file.as_raw_handle() as HANDLE;
            // SAFETY: an all-zero OVERLAPPED is the documented start state. It and the `len` bytes at `data` (borrowed by
            // the caller for this call) outlive the I/O, because this function does not return before the I/O has
            // finished: completed, failed, or cancelled at the deadline and then waited for.
            unsafe {
                let mut overlapped: OVERLAPPED = std::mem::zeroed();
                overlapped.hEvent = self.event;
                let mut done: u32 = 0;
                let started = if write {
                    WriteFile(handle, data, len, &mut done, &mut overlapped)
                } else {
                    ReadFile(handle, data, len, &mut done, &mut overlapped)
                };
                if started == 0 {
                    let error = GetLastError();
                    if error != ERROR_IO_PENDING {
                        return Err(failure(error, write));
                    }
                    let left = deadline.saturating_duration_since(Instant::now()).as_millis();
                    let wait = u32::try_from(left).unwrap_or(u32::MAX - 1).min(u32::MAX - 1);
                    if WaitForSingleObject(self.event, wait) != WAIT_OBJECT_0 {
                        CancelIoEx(handle, &overlapped);
                        // The cancelled I/O finishes (aborted, or done just in time); after this nothing uses `data`.
                        GetOverlappedResult(handle, &overlapped, &mut done, 1);
                        return Err(Io::Timeout);
                    }
                }
                if GetOverlappedResult(handle, &overlapped, &mut done, 0) == 0 {
                    let error = GetLastError();
                    if error == ERROR_MORE_DATA {
                        return Ok(done);
                    }
                    return Err(failure(error, write));
                }
                Ok(done)
            }
        }
    }

    fn failure(error: u32, write: bool) -> Io {
        match error {
            ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED if !write => Io::Closed,
            _ => Io::Failed(std::io::Error::from_raw_os_error(error as i32).kind().to_string()),
        }
    }
}

#[cfg(windows)]
fn connect(channel: &str, deadline: Instant) -> std::io::Result<fs::File> {
    pipe::connect(channel, deadline)
}

#[cfg(unix)]
fn connect(channel: &str, _deadline: Instant) -> std::io::Result<std::os::unix::net::UnixStream> {
    std::os::unix::net::UnixStream::connect(channel)
}

fn sent(e: Io) -> CallError {
    match e {
        Io::Timeout => CallError::Timeout,
        Io::Closed => CallError::NotAnswering("closed".into()),
        Io::Failed(why) => CallError::NotAnswering(why),
    }
}

/// Read the whole answer: until the agent closes its end, the deadline, or too much.
fn read_answer(mut read: impl FnMut(&mut [u8]) -> Result<usize, Io>) -> Result<Vec<u8>, CallError> {
    let mut out = Vec::new();
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        match read(&mut buf) {
            Ok(0) | Err(Io::Closed) => return Ok(out),
            Ok(n) => {
                out.extend_from_slice(&buf[..n.min(buf.len())]);
                if out.len() > MAX_ANSWER {
                    return Err(CallError::BadAnswer("too large".into()));
                }
            }
            Err(Io::Timeout) => return Err(CallError::Timeout),
            Err(Io::Failed(why)) => return Err(CallError::BadAnswer(why)),
        }
    }
}

#[cfg(windows)]
fn exchange(channel: &str, request: &[u8], deadline: Instant) -> Result<Vec<u8>, CallError> {
    let pipe = pipe::Pipe::open(channel, deadline).map_err(|e| CallError::NotAnswering(e.kind().to_string()))?;
    pipe.write_all(request, deadline).map_err(sent)?;
    read_answer(|buf| pipe.read(buf, deadline))
}

#[cfg(unix)]
fn exchange(channel: &str, request: &[u8], deadline: Instant) -> Result<Vec<u8>, CallError> {
    use std::io::{ErrorKind, Read, Write};
    let mut stream = connect(channel, deadline).map_err(|e| CallError::NotAnswering(e.kind().to_string()))?;
    let left = || deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1));
    let io = |e: std::io::Error| match e.kind() {
        ErrorKind::WouldBlock | ErrorKind::TimedOut => Io::Timeout,
        ErrorKind::BrokenPipe | ErrorKind::ConnectionReset => Io::Closed,
        kind => Io::Failed(kind.to_string()),
    };
    stream.set_write_timeout(Some(left())).map_err(|e| sent(io(e)))?;
    stream.write_all(request).map_err(|e| sent(io(e)))?;
    read_answer(|buf| {
        if Instant::now() >= deadline {
            return Err(Io::Timeout);
        }
        stream.set_read_timeout(Some(left())).map_err(io)?;
        loop {
            match stream.read(buf) {
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                other => return other.map_err(io),
            }
        }
    })
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

    /// One request; the JSON answer, or why there is none. It runs on the caller's thread and returns by the timeout: a
    /// stuck agent costs the caller that time and nothing more (its I/O is cancelled and the pipe closed).
    pub fn call(&self, method: &str, path: &str, body: Option<&serde_json::Value>, timeout: Duration) -> Result<serde_json::Value, CallError> {
        let endpoint = self.endpoint().ok_or(CallError::NoEndpoint)?;
        let channel = endpoint.channel().ok_or(CallError::NoEndpoint)?;
        let body = body.map(|b| serde_json::to_vec(b).unwrap_or_default());
        let request = http::request(method, path, &endpoint.token, body.as_deref());
        let deadline = Instant::now() + timeout;
        let raw = exchange(channel, &request, deadline)?;
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
