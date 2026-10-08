//! The few bytes of HTTP/1.1 the tray speaks to the agent over its pipe: one request per connection (`Connection:
//! close`), and an answer read to the end. The answer may say its length, come in chunks, or simply end when the agent
//! closes the pipe; all three read the same.

use std::fmt;

pub const TOKEN_HEADER: &str = "x-scopebond-agent-token";
/// The agent refuses a request body over 64 KB; its answers are small too, but a recent-blocks list can grow.
pub const MAX_ANSWER: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpError {
    /// The answer ended before its status line and headers did.
    Incomplete,
    /// Not an HTTP answer.
    Malformed(&'static str),
    TooLarge,
}

impl fmt::Display for HttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HttpError::Incomplete => write!(f, "the answer ended early"),
            HttpError::Malformed(what) => write!(f, "not an HTTP answer ({what})"),
            HttpError::TooLarge => write!(f, "the answer is too large"),
        }
    }
}

/// The request's bytes. The token must be a plain header value (the agent makes it from base64url letters).
pub fn request(method: &str, path: &str, token: &str, body: Option<&[u8]>) -> Vec<u8> {
    let clean = |s: &str| s.chars().filter(|c| !c.is_control()).collect::<String>();
    let mut head = format!(
        "{method} {} HTTP/1.1\r\nHost: localhost\r\n{TOKEN_HEADER}: {}\r\nConnection: close\r\nAccept: application/json\r\n",
        clean(path),
        clean(token)
    );
    match body {
        Some(b) => head.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n\r\n", b.len())),
        None => head.push_str("Content-Length: 0\r\n\r\n"),
    }
    let mut out = head.into_bytes();
    if let Some(b) = body {
        out.extend_from_slice(b);
    }
    out
}

/// The status and body of a whole answer (everything read until the agent closed the pipe).
pub fn parse_response(bytes: &[u8]) -> Result<(u16, Vec<u8>), HttpError> {
    if bytes.len() > MAX_ANSWER {
        return Err(HttpError::TooLarge);
    }
    let end = find(bytes, b"\r\n\r\n").ok_or(HttpError::Incomplete)?;
    let head = std::str::from_utf8(&bytes[..end]).map_err(|_| HttpError::Malformed("headers are not text"))?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next().ok_or(HttpError::Malformed("no status line"))?;
    let mut parts = status_line.splitn(3, ' ');
    let version = parts.next().unwrap_or("");
    if !version.starts_with("HTTP/1.") {
        return Err(HttpError::Malformed("no HTTP version"));
    }
    let status: u16 = parts.next().and_then(|s| s.parse().ok()).ok_or(HttpError::Malformed("no status code"))?;
    let mut length: Option<usize> = None;
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else { continue };
        let (name, value) = (name.trim().to_ascii_lowercase(), value.trim());
        if name == "content-length" {
            length = Some(value.parse().map_err(|_| HttpError::Malformed("bad content-length"))?);
        } else if name == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked") {
            chunked = true;
        }
    }
    let rest = &bytes[end + 4..];
    let body = if chunked {
        dechunk(rest)?
    } else if let Some(n) = length {
        if rest.len() < n {
            return Err(HttpError::Incomplete);
        }
        rest[..n].to_vec()
    } else {
        rest.to_vec()
    };
    Ok((status, body))
}

fn dechunk(mut rest: &[u8]) -> Result<Vec<u8>, HttpError> {
    let mut out = Vec::new();
    loop {
        let line_end = find(rest, b"\r\n").ok_or(HttpError::Incomplete)?;
        let size_text = std::str::from_utf8(&rest[..line_end]).map_err(|_| HttpError::Malformed("bad chunk size"))?;
        let size_text = size_text.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| HttpError::Malformed("bad chunk size"))?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            return Ok(out);
        }
        if rest.len() < size + 2 {
            return Err(HttpError::Incomplete);
        }
        out.extend_from_slice(&rest[..size]);
        if out.len() > MAX_ANSWER {
            return Err(HttpError::TooLarge);
        }
        rest = &rest[size + 2..];
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_get_carries_the_token_and_closes() {
        let r = String::from_utf8(request("GET", "/tray", "tok-123", None)).unwrap();
        assert!(r.starts_with("GET /tray HTTP/1.1\r\n"));
        assert!(r.contains("\r\nx-scopebond-agent-token: tok-123\r\n"));
        assert!(r.contains("\r\nConnection: close\r\n"));
        assert!(r.ends_with("Content-Length: 0\r\n\r\n"));
    }

    #[test]
    fn a_post_says_its_length() {
        let r = String::from_utf8(request("POST", "/settings", "t", Some(br#"{"notifications":"off"}"#))).unwrap();
        assert!(r.contains("Content-Type: application/json\r\nContent-Length: 23\r\n\r\n{\"notifications\":\"off\"}"));
    }

    #[test]
    fn nothing_from_the_token_or_path_can_add_a_header() {
        let r = String::from_utf8(request("GET", "/tray\r\nX-Evil: 1", "t\r\nX-Evil: 2", None)).unwrap();
        assert!(!r.contains("\r\nX-Evil"));
    }

    #[test]
    fn reads_an_answer_with_a_length() {
        let (status, body) = parse_response(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}").unwrap();
        assert_eq!((status, body.as_slice()), (200, b"{}".as_slice()));
    }

    #[test]
    fn reads_a_chunked_answer() {
        let raw = b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n4\r\n{\"a\"\r\n5;x=y\r\n:1}  \r\n0\r\n\r\n";
        let (_, body) = parse_response(raw).unwrap();
        assert_eq!(body, b"{\"a\":1}  ");
    }

    #[test]
    fn reads_an_answer_that_ends_with_the_connection() {
        let (status, body) = parse_response(b"HTTP/1.0 401 Unauthorized\r\n\r\n{\"error\":\"unauthorized\"}").unwrap();
        assert_eq!(status, 401);
        assert_eq!(body, br#"{"error":"unauthorized"}"#);
    }

    #[test]
    fn a_cut_or_strange_answer_is_an_error() {
        assert_eq!(parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n{}"), Err(HttpError::Incomplete));
        assert_eq!(parse_response(b"HTTP/1.1 200 OK\r\n"), Err(HttpError::Incomplete));
        assert!(matches!(parse_response(b"SSH-2.0\r\n\r\n"), Err(HttpError::Malformed(_))));
        assert!(matches!(parse_response(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\nzz\r\n"), Err(HttpError::Malformed(_))));
    }
}
