//! Copies a PDF and removes owner-password permissions from the copy, as an
//! Edit Content session does: `cargo run --example edit_content_unlock -- in.pdf out.pdf`
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: edit_content_unlock <in.pdf> <out.pdf>");
        std::process::exit(2);
    }
    std::fs::copy(&args[1], &args[2]).expect("copy");
    let rewritten = dokuwu_core::ops::edit_content::unlock::unlock_permission_only(Path::new(&args[2]));
    println!("permissions removed: {rewritten}");
}
