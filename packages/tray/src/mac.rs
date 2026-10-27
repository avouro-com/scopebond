//! macOS: what the menu-bar app asks of the system, with macOS's own tools by their full paths. Opening at login is the
//! app's own LaunchAgent (the package installs it for every user; launchd keeps a person's choice to turn it off); the
//! agent is kept running by its own LaunchAgent, so the app restarts it through launchd and never starts a second one;
//! notifications, the clipboard and a message box come from the system's own programs.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::menu::Autostart;

/// The agent's LaunchAgent label (the package's and the agent's own autostart label).
pub const AGENT_LABEL: &str = "com.scopebond.agent";
/// The menu-bar app's own LaunchAgent, which the package puts in /Library/LaunchAgents.
pub const TRAY_LABEL: &str = "com.scopebond.tray";
pub const TRAY_PLIST: &str = "/Library/LaunchAgents/com.scopebond.tray.plist";
/// The agent program the package installs.
pub const AGENT_PROGRAM: &str = "/usr/local/bin/scopebond-agent";
/// The package's uninstall script (it needs an administrator).
pub const UNINSTALL_SCRIPT: &str = "/Library/Application Support/Scopebond/uninstall.sh";

fn output(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn succeeds(program: &str, args: &[&str]) -> bool {
    Command::new(program).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

/// This person's launchd domain, `gui/<uid>`.
fn domain() -> String {
    format!("gui/{}", output("/usr/bin/id", &["-u"]).unwrap_or_default().trim())
}

/// Text on the clipboard (`pbcopy`).
pub fn copy_text(text: &str) -> bool {
    let Ok(mut child) = Command::new("/usr/bin/pbcopy").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else { return false };
    let written = child.stdin.take().is_some_and(|mut input| input.write_all(text.as_bytes()).is_ok());
    child.wait().is_ok_and(|s| s.success()) && written
}

/// The text reaches AppleScript as an argument, never as part of its source.
const DIALOG: [&str; 3] = ["on run argv", "display dialog (item 2 of argv) with title (item 1 of argv) buttons {\"OK\"} default button 1", "end run"];
const NOTIFICATION: [&str; 3] = ["on run argv", "display notification (item 2 of argv) with title (item 1 of argv)", "end run"];

fn osascript(script: &[&str; 3], title: &str, text: &str) -> bool {
    let mut args: Vec<&str> = Vec::new();
    for line in script {
        args.extend(["-e", line]);
    }
    args.extend([title, text]);
    succeeds("/usr/bin/osascript", &args)
}

/// Uninstall Scopebond…: ask first, then run the package's uninstall script behind macOS's own administrator prompt, and
/// say what it did. The script's path reaches AppleScript as an argument. The script stops this app too, so the dialog
/// runs in its own process group, which launchd leaves alone when it ends the app; exit 75 (the workspace could not be
/// told) is a removal all the same.
const UNINSTALL: [&str; 9] = [
    "on run argv",
    "display dialog \"Remove Scopebond from this Mac? Your coding agents will then run without its checks, and this Mac stops sending records to your workspace.\" with title \"Uninstall Scopebond\" buttons {\"Cancel\", \"Uninstall\"} default button \"Cancel\" cancel button \"Cancel\" with icon caution",
    "try",
    "set said to do shell script (quoted form of (item 1 of argv)) & \" || [ $? -eq 75 ]\" with administrator privileges",
    "display dialog said with title \"Uninstall Scopebond\" buttons {\"OK\"} default button 1",
    "on error problem number n",
    "if n is not -128 then display dialog (\"Scopebond could not be removed: \" & problem) with title \"Uninstall Scopebond\" buttons {\"OK\"} default button 1",
    "end try",
    "end run",
];

/// Start the Uninstall Scopebond… dialog; false when it could not start.
pub fn uninstall() -> bool {
    use std::os::unix::process::CommandExt;
    let mut args: Vec<&str> = Vec::new();
    for line in UNINSTALL {
        args.extend(["-e", line]);
    }
    args.push(UNINSTALL_SCRIPT);
    Command::new("/usr/bin/osascript").args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0).spawn().is_ok()
}

/// A message box with one button.
pub fn message(title: &str, text: &str) {
    let _ = osascript(&DIALOG, title, text);
}

/// A notification in Notification Center. macOS shows it under the program that posts it; there are no buttons, and the
/// menu-bar icon opens the panel for whatever it is about.
pub fn notify(title: &str, text: &str) -> bool {
    osascript(&NOTIFICATION, title, text)
}

/// Whether the process with this id is still running (and is this person's).
pub fn process_alive(pid: u32) -> bool {
    pid != 0 && succeeds("/bin/kill", &["-0", &pid.to_string()])
}

/// End process `pid`, but only when it runs `program`, and wait at most `wait` for it to be gone.
pub fn end_if_running(pid: u32, program: &Path, wait: Duration) -> Result<(), String> {
    if pid == 0 {
        return Err("no process id".into());
    }
    let Some(running) = output("/bin/ps", &["-p", &pid.to_string(), "-o", "comm="]) else { return Ok(()) };
    let running = running.trim();
    if Path::new(running) != program {
        return Err(format!("process {pid} runs {running}, not {}", program.display()));
    }
    let _ = succeeds("/bin/kill", &["-TERM", &pid.to_string()]);
    let end = Instant::now() + wait;
    while process_alive(pid) {
        if Instant::now() >= end {
            let _ = succeeds("/bin/kill", &["-KILL", &pid.to_string()]);
            std::thread::sleep(Duration::from_millis(200));
            return if process_alive(pid) { Err(format!("process {pid} did not end")) } else { Ok(()) };
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

/// Start the agent now when it is not running: launchd runs it from its LaunchAgent (`launchctl kickstart`). A hung
/// agent is ended first (`end_if_running`), as on Windows.
pub fn start_agent() -> bool {
    succeeds("/bin/launchctl", &["kickstart", &format!("{}/{AGENT_LABEL}", domain())])
}

/// Whether launchd's list of disabled services (`launchctl print-disabled`) has `label` disabled (`=> disabled`, or
/// `=> true` from older macOS).
pub fn disabled_in(listing: &str, label: &str) -> bool {
    let quoted = format!("\"{label}\"");
    listing.lines().any(|line| {
        let line = line.trim();
        line.starts_with(&quoted) && matches!(line[quoted.len()..].trim().strip_prefix("=>").map(str::trim), Some("disabled") | Some("true"))
    })
}

/// Whether the menu-bar app opens at this person's login: its LaunchAgent is installed and not turned off for them.
pub fn autostart_state() -> Autostart {
    if !Path::new(TRAY_PLIST).exists() {
        return Autostart::Off;
    }
    let listing = output("/bin/launchctl", &["print-disabled", &domain()]).unwrap_or_default();
    if disabled_in(&listing, TRAY_LABEL) { Autostart::Off } else { Autostart::On }
}

/// Turn opening at login on or off for this person (launchd keeps it, also across an upgrade of the package).
pub fn set_autostart(on: bool) -> bool {
    Path::new(TRAY_PLIST).exists() && succeeds("/bin/launchctl", &[if on { "enable" } else { "disable" }, &format!("{}/{TRAY_LABEL}", domain())])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_disabled_label_is_read_from_launchds_list() {
        let listing = "\tdisabled services = {\n\t\t\"com.apple.Siri.agent\" => enabled\n\t\t\"com.scopebond.tray\" => disabled\n\t\t\"com.scopebond.agentx\" => disabled\n\t}\n";
        assert!(disabled_in(listing, "com.scopebond.tray"));
        assert!(!disabled_in(listing, "com.apple.Siri.agent"));
        assert!(!disabled_in(listing, "com.scopebond.agent"), "another label that starts the same is not this one");
        assert!(disabled_in("\"com.scopebond.tray\" => true", "com.scopebond.tray"), "older macOS");
        assert!(!disabled_in("\"com.scopebond.tray\" => false", "com.scopebond.tray"));
    }

    #[test]
    fn ends_a_process_only_when_it_runs_the_program_named() {
        let mut child = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let pid = child.id();
        // Reaped as soon as it ends (the agent is never the app's own child, so it never lingers as a zombie).
        let reaper = std::thread::spawn(move || child.wait());
        assert!(process_alive(pid));
        let refused = end_if_running(pid, Path::new(AGENT_PROGRAM), Duration::from_secs(5));
        assert!(refused.is_err(), "{refused:?}");
        assert!(process_alive(pid), "a process that is not the agent is left alone");
        assert_eq!(end_if_running(pid, Path::new("/bin/sleep"), Duration::from_secs(10)), Ok(()));
        let _ = reaper.join();
        assert!(!process_alive(pid));
        assert_eq!(end_if_running(0, Path::new("/bin/sleep"), Duration::from_secs(1)), Err("no process id".into()));
    }

    #[test]
    fn text_reaches_applescript_as_an_argument() {
        for line in DIALOG.iter().chain(NOTIFICATION.iter()) {
            assert!(!line.contains("{title}") && !line.contains("{text}"));
        }
        assert!(NOTIFICATION[1].contains("item 2 of argv") && DIALOG[1].contains("item 1 of argv"));
    }

    #[test]
    fn uninstall_asks_first_and_takes_the_script_as_an_argument() {
        let script = UNINSTALL.join("\n");
        assert!(!script.contains(UNINSTALL_SCRIPT), "the path is an argument, never AppleScript source");
        assert!(script.contains("quoted form of (item 1 of argv)"));
        let ask = UNINSTALL.iter().position(|l| l.contains("cancel button \"Cancel\"")).unwrap();
        let run = UNINSTALL.iter().position(|l| l.contains("with administrator privileges")).unwrap();
        assert!(ask < run, "it asks before it removes anything");
        assert!(UNINSTALL[run].contains("[ $? -eq 75 ]"), "a workspace that could not be told is still a removal");
        assert!(script.contains("if n is not -128"), "Cancel at the administrator prompt says nothing");
    }
}
