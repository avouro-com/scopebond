//! The client's one version. The tray, the agent and the hook inside it ship as one Scopebond release whose version is the
//! agent package's (`packages/agent/package.json`); build.rs reads it from there and gives it to the program as
//! `SCOPEBOND_VERSION`, so About and the panel say "Scopebond 0.11.5", never the tray crate's own version.

/// The `version` a package.json names (its first "version" key, the package's own), when it is a plain version.
pub fn package_version(package_json: &str) -> Option<String> {
    let key = "\"version\"";
    let at = package_json.find(key)?;
    let rest = package_json[at + key.len()..].trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
    let value = &rest[..rest.find('"')?];
    let plain = !value.is_empty()
        && value.len() <= 64
        && value.starts_with(|c: char| c.is_ascii_digit())
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    plain.then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_packages_own_version() {
        let json = "{\n  \"name\": \"@scopebond/agent\",\n  \"version\": \"0.11.5\",\n  \"dependencies\": { \"x\": { \"version\": \"9.9.9\" } }\n}";
        assert_eq!(package_version(json).as_deref(), Some("0.11.5"));
        assert_eq!(package_version("{\"version\":\"1.2.3-rc.1\"}").as_deref(), Some("1.2.3-rc.1"));
        assert_eq!(package_version("{\"name\":\"x\"}"), None);
        assert_eq!(package_version("{\"version\": 3}"), None);
        assert_eq!(package_version("{\"version\": \"latest\"}"), None, "only a plain version");
        assert_eq!(package_version("{\"version\": \"1.0\\\"; rm\"}"), None);
    }
}
