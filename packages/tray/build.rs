// Before Tauri's own build step: the program's icon (drawn by src/icon.rs, so no image file is kept in the repository)
// and the status panel's page (assembled from ui/, so the page itself is a build output).

use std::fs;
use std::path::{Path, PathBuf};

#[allow(dead_code)]
#[path = "src/icon.rs"]
mod icon;

/// Write only when the content changed, so an unchanged build does not rebuild the program.
fn write_if_changed(path: &Path, bytes: &[u8]) {
    if fs::read(path).map(|old| old == bytes).unwrap_or(false) {
        return;
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create folder");
    }
    fs::write(path, bytes).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
}

/// The page the panel loads: a shell around ui/panel.css and ui/panel.js (no inline script or style, which the
/// content security policy forbids).
const PAGE: &str = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"color-scheme\" content=\"light dark\">\n<title>Scopebond</title>\n<link rel=\"stylesheet\" href=\"panel.css\">\n<script src=\"panel.js\" defer></script>\n</head>\n<body>\n<main id=\"panel\" aria-labelledby=\"headline\"></main>\n</body>\n</html>\n";

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    println!("cargo:rerun-if-changed=src/icon.rs");
    println!("cargo:rerun-if-changed=ui");

    let ico = out.join("scopebond.ico");
    write_if_changed(&ico, &icon::ico(icon::IconState::Protected, &[16, 20, 24, 32, 40, 48, 64, 256]));

    let dist = manifest.join("dist");
    write_if_changed(&dist.join("index.html"), PAGE.as_bytes());
    for name in ["panel.css", "panel.js"] {
        let source = manifest.join("ui").join(name);
        let bytes = fs::read(&source).unwrap_or_else(|e| panic!("read {}: {e}", source.display()));
        write_if_changed(&dist.join(name), &bytes);
    }

    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(tauri_build::WindowsAttributes::new().window_icon_path(&ico)))
        .expect("tauri build step");
}
