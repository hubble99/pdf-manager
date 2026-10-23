//! Adds fonts to a throw-away library and prints what each one is called, for
//! `tests/fixtures/font-library/parity.py`.
//!
//!     cargo run --release --example font_library -- font1.ttf font2.otf ...
//!
//! One JSON object per line: `{file, id, family, weight, bold, italic}` or
//! `{file, error}`.

use std::path::Path;

use dokuwu_core::ops::font_library::FontLibrary;

fn main() {
    let dir = tempfile::tempdir().expect("temp folder");
    let library = FontLibrary::new(dir.path());
    for file in std::env::args().skip(1) {
        let name = Path::new(&file)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let line = match library.add(Path::new(&file)) {
            Ok(f) => {
                serde_json::json!({"file": name, "id": f.id, "family": f.family, "weight": f.weight, "bold": f.bold, "italic": f.italic})
            }
            Err(e) => serde_json::json!({"file": name, "error": e.to_string()}),
        };
        println!("{line}");
    }
}
