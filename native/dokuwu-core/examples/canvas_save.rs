//! Stamps Canvas annotations onto a PDF, for manual checks and for
//! `tests/fixtures/canvas-save/parity.py`.
//!
//!     cargo run --release --example canvas_save -- source.pdf annotations.json out_dir [fonts_dir]
//!
//! Prints the path of the result. `fonts_dir` is a font library folder.

use std::path::PathBuf;

use dokuwu_core::job::JobContext;
use dokuwu_core::ops::canvas_save::{save_canvas, SaveOptions};
use dokuwu_core::ops::font_library::FontLibrary;

fn main() {
    let mut args = std::env::args().skip(1);
    let source: PathBuf = args.next().expect("source.pdf").into();
    let annotations: PathBuf = args.next().expect("annotations.json").into();
    let out_dir: PathBuf = args.next().expect("out_dir").into();
    let library = args.next().map(FontLibrary::new);
    let options = SaveOptions { output_dir: out_dir, output_name: Some("rust".into()), fonts: library.as_ref() };
    match save_canvas(&source, &annotations, &options, &JobContext::detached()) {
        Ok(report) => println!("{}", report.output_path.display()),
        Err(err) => {
            eprintln!("failed: {err} ({})", err.code());
            std::process::exit(1);
        }
    }
}
