//! The tray's own log, `tray.log` in the Scopebond home beside the agent's `agent.log`: one line per event, kept under a
//! megabyte (the previous megabyte is kept as `tray.log.1`).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const LIMIT: u64 = 1024 * 1024;
static FILE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// UTC time as `2026-10-08T09:12:03Z`.
pub fn utc(seconds_since_epoch: u64) -> String {
    let days = (seconds_since_epoch / 86_400) as i64;
    let rem = seconds_since_epoch % 86_400;
    // Days to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

pub fn now() -> String {
    utc(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0))
}

/// Log to `tray.log` in this folder from now on.
pub fn init(home: &Path) {
    let _ = fs::create_dir_all(home);
    *FILE.lock().unwrap_or_else(|e| e.into_inner()) = Some(home.join("tray.log"));
}

pub fn line(text: &str) {
    let guard = FILE.lock().unwrap_or_else(|e| e.into_inner());
    let Some(path) = guard.as_ref() else { return };
    if fs::metadata(path).map(|m| m.len() > LIMIT).unwrap_or(false) {
        let _ = fs::rename(path, path.with_extension("log.1"));
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{} {}", now(), text.replace(['\r', '\n'], " "));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_dates() {
        assert_eq!(utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(utc(1_791_458_000), "2026-10-08T11:13:20Z");
    }
}
