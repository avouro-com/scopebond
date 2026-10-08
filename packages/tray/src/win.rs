//! The few Windows calls the tray makes itself: put text on the clipboard, show a plain message box, and ask whether a
//! process is still running.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

use windows_sys::Win32::Foundation::{CloseHandle, GlobalFree, STILL_ACTIVE};
use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND, MB_TOPMOST};

/// Text in UTF-16 with the terminating zero, as Windows takes it.
pub fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

const CF_UNICODETEXT: u32 = 13;

/// Put `text` on the clipboard. Whether it worked.
pub fn copy_text(text: &str) -> bool {
    let data = wide(text);
    let bytes = data.len() * 2;
    // SAFETY: the standard clipboard sequence. The memory belongs to the clipboard once SetClipboardData succeeds, and
    // is freed here only when it did not.
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return false;
        }
        let mut ok = false;
        if EmptyClipboard() != 0 {
            let memory = GlobalAlloc(GMEM_MOVEABLE, bytes);
            if !memory.is_null() {
                let target = GlobalLock(memory) as *mut u16;
                if !target.is_null() {
                    std::ptr::copy_nonoverlapping(data.as_ptr(), target, data.len());
                    GlobalUnlock(memory);
                    ok = !SetClipboardData(CF_UNICODETEXT, memory).is_null();
                }
                if !ok {
                    GlobalFree(memory);
                }
            }
        }
        CloseClipboard();
        ok
    }
}

/// A message box with one OK button. It blocks the calling thread until the person closes it.
pub fn message(title: &str, text: &str) {
    let (title, text) = (wide(title), wide(text));
    // SAFETY: both strings are zero-terminated and live until the call returns.
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND | MB_TOPMOST);
    }
}

/// Where Windows keeps the programs that start at sign-in.
pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// A text value from the registry, for this user (`machine` false) or for the computer.
pub fn read_string(machine: bool, key: &str, name: &str) -> Option<String> {
    let root = if machine { HKEY_LOCAL_MACHINE } else { HKEY_CURRENT_USER };
    let (key, name) = (wide(key), wide(name));
    let mut size: u32 = 0;
    // SAFETY: first the size, then the value into a buffer of that size; both strings are zero-terminated.
    unsafe {
        if RegGetValueW(root, key.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), std::ptr::null_mut(), &mut size) != 0 {
            return None;
        }
        let mut buf = vec![0u16; size as usize / 2 + 1];
        let mut size = (buf.len() * 2) as u32;
        if RegGetValueW(root, key.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut size) != 0 {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    }
}

/// Whether the process with this id is still running.
pub fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: a query-only handle, closed before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        ok && code == STILL_ACTIVE as u32
    }
}

/// Whether a path Windows reports names `program` (case, `\\?\` and slashes aside).
pub fn same_path(reported: &str, program: &std::path::Path) -> bool {
    let norm = |s: &str| s.trim_start_matches(r"\\?\").replace('/', "\\").to_lowercase();
    norm(reported) == norm(&program.to_string_lossy())
}

/// End process `pid`, but only when it runs `program` (checked on the same handle that ends it, so a reused process id
/// never ends something else), and wait at most `wait` for it to be gone. Ok once it is gone; otherwise why not.
pub fn end_if_running(pid: u32, program: &std::path::Path, wait: std::time::Duration) -> Result<(), String> {
    use windows_sys::Win32::System::Threading::{QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject};
    const PROCESS_TERMINATE: u32 = 0x0001;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const WAIT_OBJECT_0: u32 = 0;
    if pid == 0 {
        return Err("no process id".into());
    }
    // SAFETY: one process handle, closed on every path; the buffer outlives the call that fills it, and `len` says how
    // much of it was filled.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return if process_alive(pid) { Err(format!("process {pid} could not be opened")) } else { Ok(()) };
        }
        let mut buf = vec![0u16; 32 * 1024];
        let mut len = buf.len() as u32;
        let path = if QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len) != 0 {
            Some(String::from_utf16_lossy(&buf[..(len as usize).min(buf.len())]))
        } else {
            None
        };
        let result = match path {
            Some(path) if same_path(&path, program) => {
                TerminateProcess(handle, 1);
                let ms = u32::try_from(wait.as_millis()).unwrap_or(u32::MAX - 1).min(u32::MAX - 1);
                if WaitForSingleObject(handle, ms) == WAIT_OBJECT_0 {
                    Ok(())
                } else {
                    Err(format!("process {pid} did not end"))
                }
            }
            Some(path) => Err(format!("process {pid} runs {path}, not {}", program.display())),
            None => Err(format!("what process {pid} runs could not be read")),
        };
        CloseHandle(handle);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::time::Duration;

    #[test]
    fn paths_compare_as_windows_compares_them() {
        let program = Path::new(r"C:\Program Files\Scopebond\scopebond-agent.exe");
        assert!(same_path(r"C:\Program Files\Scopebond\scopebond-agent.exe", program));
        assert!(same_path(r"c:\program files\scopebond\SCOPEBOND-AGENT.EXE", program));
        assert!(same_path(r"\\?\C:\Program Files\Scopebond\scopebond-agent.exe", program));
        assert!(!same_path(r"C:\Program Files\Scopebond\scopebond-agent.exe.bak", program));
        assert!(!same_path(r"C:\Windows\System32\cmd.exe", program));
    }

    #[test]
    fn ends_a_process_only_when_it_runs_the_program_named() {
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into());
        let mut child = std::process::Command::new(&comspec).args(["/d", "/c", "ping -n 60 127.0.0.1 > nul"]).spawn().unwrap();
        let pid = child.id();
        let other = Path::new(r"C:\Program Files\Scopebond\scopebond-agent.exe");
        let refused = end_if_running(pid, other, Duration::from_secs(5));
        assert!(refused.is_err(), "{refused:?}");
        assert!(process_alive(pid), "a process that is not the agent is left alone");
        assert_eq!(end_if_running(pid, Path::new(&comspec), Duration::from_secs(10)), Ok(()));
        assert!(!process_alive(pid));
        let _ = child.wait();
        assert_eq!(end_if_running(0, Path::new(&comspec), Duration::from_secs(1)), Err("no process id".into()));
    }
}
