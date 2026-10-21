//! Converts WEBP files from the command line, for manual checks.
//! `cargo run --release --example convert_webp -- <png|jpg|jpeg> <out-dir> <file.webp>...`

use std::path::PathBuf;

use dokuwu_core::job::JobContext;
use dokuwu_core::ops::image_convert::{convert_webp_images, ConvertOptions, TargetFormat};

fn main() {
    let mut args = std::env::args().skip(1);
    let format = match args.next().as_deref() {
        Some("png") => TargetFormat::Png,
        Some("jpg") => TargetFormat::Jpg,
        Some("jpeg") => TargetFormat::Jpeg,
        _ => {
            eprintln!("usage: convert_webp <png|jpg|jpeg> <out-dir> <file.webp>...");
            std::process::exit(2);
        }
    };
    let output_dir = PathBuf::from(args.next().expect("output folder"));
    let inputs: Vec<PathBuf> = args.map(PathBuf::from).collect();
    let options = ConvertOptions {
        format,
        quality: 90,
        output_dir,
    };
    let started = std::time::Instant::now();
    match convert_webp_images(&inputs, &options, &JobContext::detached()) {
        Ok(report) => {
            for file in &report.files {
                match (&file.output, &file.error) {
                    (Some(out), _) => println!(
                        "ok   {} -> {} ({} bytes{})",
                        file.source.display(),
                        out.display(),
                        file.output_bytes.unwrap_or(0),
                        if file.animated { ", first frame" } else { "" }
                    ),
                    (None, Some(err)) => {
                        println!("fail {}: [{}] {}", file.source.display(), err.code(), err)
                    }
                    _ => {}
                }
            }
            println!(
                "{} ok, {} failed in {:?}",
                report.succeeded,
                report.failed,
                started.elapsed()
            );
        }
        Err(err) => {
            eprintln!("[{}] {}", err.code(), err);
            std::process::exit(1);
        }
    }
}
