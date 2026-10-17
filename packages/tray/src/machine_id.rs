//! This computer's machine id for its workspace, worked out exactly as the hook, the agent and the gateway work it out
//! (packages/gateway: machine-id.ts and node-machine-id.ts), so every Scopebond program on a computer names it the same
//! way. It is `m1:` and the unpadded base64url SHA-256 of "scopebond-machine-id/v1\n" + scope + "\n" + raw id, where the
//! scope is the workspace's id once it is known and "unscoped" before, and the raw id is the operating system's own
//! (trimmed, lowercase): `MachineGuid` under HKLM\SOFTWARE\Microsoft\Cryptography on Windows, `IOPlatformUUID` from
//! `ioreg` on macOS, /etc/machine-id or else /var/lib/dbus/machine-id on Linux. The raw id is only hashed here: never
//! sent, logged, stored or shown. When none can be read there is no machine id; a host name or a network address is
//! never used instead. The shared test vectors (packages/gateway/test/machine-id-vectors.json) hold both to the same
//! answers. SHA-256 is written out here so the tray takes no new dependency for it.

/// The domain separator hashed in front of the scope and the raw id.
pub const DOMAIN: &str = "scopebond-machine-id/v1";

/// The scope before the workspace's id is known.
pub const UNSCOPED: &str = "unscoped";

/// Where Linux keeps its machine id, in the order they are tried.
pub const LINUX_FILES: [&str; 2] = ["/etc/machine-id", "/var/lib/dbus/machine-id"];

/// The longest raw id or scope used; anything longer is not one.
const MAX_LENGTH: usize = 256;

/// Control characters (a newline would change what the hash covers), as the TypeScript checks them.
fn has_control(value: &str) -> bool {
    value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}

/// The raw id as it is hashed (trimmed, lowercase), or None when it is not a usable id.
pub fn normalize_raw(raw: &str) -> Option<String> {
    let value = raw.trim().to_lowercase();
    // systemd writes "uninitialized" into /etc/machine-id until the first boot has finished.
    if value.is_empty() || value.len() > MAX_LENGTH || has_control(&value) || value == "uninitialized" {
        return None;
    }
    Some(value)
}

/// The scope a machine id is computed with: the workspace's id when it is a usable one, else "unscoped".
pub fn scope(workspace_id: Option<&str>) -> String {
    match workspace_id.map(str::trim) {
        Some(value) if !value.is_empty() && value.len() <= MAX_LENGTH && !has_control(value) => value.to_string(),
        _ => UNSCOPED.to_string(),
    }
}

/// The machine id for the raw OS id `raw` in the scope of `workspace_id` (unscoped without one), or None when `raw` is
/// not usable.
pub fn compute(raw: &str, workspace_id: Option<&str>) -> Option<String> {
    let id = normalize_raw(raw)?;
    let material = format!("{DOMAIN}\n{}\n{id}", scope(workspace_id));
    Some(format!("m1:{}", base64url(&sha256(material.as_bytes()))))
}

/// Whether `value` is a machine id in the form a workspace accepts (`m1:` and 43 base64url characters).
pub fn is_machine_id(value: &str) -> bool {
    value.len() == 46
        && value.starts_with("m1:")
        && value.as_bytes()[3..].iter().all(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_')
}

/// The value of `IOPlatformUUID` in what `ioreg -rd1 -c IOPlatformExpertDevice` printed, or None.
pub fn parse_ioreg(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("\"IOPlatformUUID\"")?;
        let value = rest.trim_start().strip_prefix('=')?.trim_start().strip_prefix('"')?;
        let end = value.find('"')?;
        normalize_raw(&value[..end])
    })
}

/// The first usable id in Linux's machine id files, read with `read` (None when a file cannot be read).
pub fn read_linux(read: impl Fn(&str) -> Option<String>) -> Option<String> {
    LINUX_FILES.into_iter().find_map(|file| read(file).and_then(|text| normalize_raw(&text)))
}

/// This computer's raw OS machine id (trimmed, lowercase), or None. For hashing here only.
#[cfg(windows)]
pub fn read_raw() -> Option<String> {
    crate::win::read_string(true, r"SOFTWARE\Microsoft\Cryptography", "MachineGuid").and_then(|value| normalize_raw(&value))
}

/// This computer's raw OS machine id (trimmed, lowercase), or None. For hashing here only.
#[cfg(target_os = "macos")]
pub fn read_raw() -> Option<String> {
    let output = std::process::Command::new("/usr/sbin/ioreg").args(["-rd1", "-c", "IOPlatformExpertDevice"]).output().ok()?;
    parse_ioreg(&String::from_utf8_lossy(&output.stdout))
}

/// This computer's raw OS machine id (trimmed, lowercase), or None. For hashing here only.
#[cfg(target_os = "linux")]
pub fn read_raw() -> Option<String> {
    read_linux(|file| std::fs::read_to_string(file).ok())
}

/// No machine id on other systems.
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
pub fn read_raw() -> Option<String> {
    None
}

/// This computer's machine id in the scope of `workspace_id`, or None when the OS gives no machine id.
pub fn machine_id(workspace_id: Option<&str>) -> Option<String> {
    read_raw().and_then(|raw| compute(&raw, workspace_id))
}

/// Unpadded base64url.
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let byte = |i: usize| u32::from(chunk.get(i).copied().unwrap_or(0));
        let n = (byte(0) << 16) | (byte(1) << 8) | byte(2);
        for i in 0..=chunk.len() {
            out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
        }
    }
    out
}

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// SHA-256 (FIPS 180-4).
pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    let mut message = data.to_vec();
    let bits = (data.len() as u64).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bits.to_be_bytes());
    for block in message.chunks(64) {
        let mut w = [0u32; 64];
        for (i, word) in block.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (state, value) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *state = state.wrapping_add(value);
        }
    }
    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A file reader that knows only these files.
    fn files(map: Vec<(&'static str, &'static str)>) -> impl Fn(&str) -> Option<String> {
        move |file: &str| map.iter().find(|(name, _)| *name == file).map(|(_, text)| text.to_string())
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn sha256_known_answers() {
        assert_eq!(hex(&sha256(b"")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(hex(&sha256(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        // Two blocks.
        assert_eq!(
            hex(&sha256(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    #[test]
    fn base64url_without_padding() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn the_shared_test_vectors() {
        let file: serde_json::Value = serde_json::from_str(include_str!("../../gateway/test/machine-id-vectors.json")).expect("vectors parse");
        let vectors = file["vectors"].as_array().expect("a list of vectors");
        assert!(vectors.len() >= 4);
        for v in vectors {
            let raw = v["raw"].as_str().expect("raw");
            let scope = v["scope"].as_str().expect("scope");
            let expected = v["machine_id"].as_str().expect("machine_id");
            assert_eq!(compute(raw, Some(scope)).as_deref(), Some(expected), "{raw:?} in {scope}");
            assert!(is_machine_id(expected));
        }
    }

    #[test]
    fn scoped_trimmed_and_lowercased() {
        let raw = "8f14e45f-ceea-467a-9575-0b3b0d6c4e2a";
        let unscoped = compute(raw, None).unwrap();
        assert!(is_machine_id(&unscoped));
        assert_eq!(Some(unscoped.clone()), compute(raw, Some(UNSCOPED)));
        assert_eq!(Some(unscoped.clone()), compute(raw, Some("  ")));
        assert_ne!(compute(raw, Some("org_a")), Some(unscoped.clone()));
        assert_eq!(compute(&raw.to_uppercase(), Some("org_a")), compute(&format!(" {raw}\n"), Some("org_a")));
        for bad in ["", "   ", "uninitialized", "a\nb"] {
            assert_eq!(normalize_raw(bad), None, "{bad:?}");
            assert_eq!(compute(bad, Some("org_a")), None);
        }
        assert_eq!(normalize_raw(&"x".repeat(300)), None);
        assert_eq!(scope(Some("org\nx")), UNSCOPED);
        for not_one in ["", "m1:short", "m2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "m1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa+"] {
            assert!(!is_machine_id(not_one), "{not_one}");
        }
    }

    #[test]
    fn macos_ioreg_output() {
        let output = "+-o J314sAP  <class IOPlatformExpertDevice, id 0x100000110, registered, matched, active, busy 0 (12 ms), retain 39>\n    {\n      \"IOPlatformSerialNumber\" = \"C02XXXXXXXXX\"\n      \"IOPlatformUUID\" = \"8F14E45F-CEEA-467A-9575-0B3B0D6C4E2A\"\n    }\n";
        assert_eq!(parse_ioreg(output).as_deref(), Some("8f14e45f-ceea-467a-9575-0b3b0d6c4e2a"));
        assert_eq!(parse_ioreg("\"IOPlatformSerialNumber\" = \"C02XXXXXXXXX\""), None);
    }

    #[test]
    fn linux_files_in_order() {
        let id = "0123456789ABCDEF0123456789ABCDEF\n";
        assert_eq!(read_linux(files(vec![("/etc/machine-id", id), ("/var/lib/dbus/machine-id", "ffff")])).as_deref(), Some("0123456789abcdef0123456789abcdef"));
        assert_eq!(read_linux(files(vec![("/var/lib/dbus/machine-id", id)])).as_deref(), Some("0123456789abcdef0123456789abcdef"));
        assert_eq!(read_linux(files(vec![("/etc/machine-id", "\n"), ("/var/lib/dbus/machine-id", id)])).as_deref(), Some("0123456789abcdef0123456789abcdef"));
        assert_eq!(read_linux(files(vec![("/etc/machine-id", "uninitialized\n")])), None);
        assert_eq!(read_linux(files(vec![])), None);
    }

    #[cfg(windows)]
    #[test]
    fn this_windows_computer_has_one() {
        let raw = read_raw().expect("Windows keeps a MachineGuid");
        assert_eq!(normalize_raw(&raw).as_deref(), Some(raw.as_str()));
        assert!(is_machine_id(&machine_id(Some("org_test")).unwrap()));
    }
}
