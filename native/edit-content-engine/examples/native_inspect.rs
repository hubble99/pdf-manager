//! Prints the native resource inspection of a PDF as compact JSON.
//!
//! `cargo run --release --example native_inspect -- file.pdf`

use std::path::Path;

fn main() {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: native_inspect <file.pdf>");
        std::process::exit(2);
    };
    match edit_content_engine::native_inspector::inspect_file_with_reason(Path::new(&path)) {
        Ok(value) => println!("{}", serde_json::to_string(&value).unwrap()),
        Err(why) => {
            eprintln!("unsupported: {why}");
            println!("{{\"supported\":false}}");
            std::process::exit(1);
        }
    }
}
