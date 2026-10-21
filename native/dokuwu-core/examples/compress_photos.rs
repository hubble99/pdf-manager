//! Compresses JPEG and PNG photos from the command line, for manual checks.
//! `cargo run --release --example compress_photos -- <quality> <max-side|0> <keep|jpeg> <out-dir> <photo>...`

use std::path::PathBuf;

use dokuwu_core::job::JobContext;
use dokuwu_core::ops::photo_compress::{compress_photos, CompressOptions, OutputFormat};

fn main() {
    let usage = "usage: compress_photos <quality> <max-side|0> <keep|jpeg> <out-dir> <photo>...";
    let mut args = std::env::args().skip(1);
    let mut next = || {
        args.next().unwrap_or_else(|| {
            eprintln!("{usage}");
            std::process::exit(2);
        })
    };
    let quality: u8 = next().parse().expect("quality");
    let max_side = match next().parse::<u32>().expect("max side") {
        0 => None,
        n => Some(n),
    };
    let format = match next().as_str() {
        "keep" => OutputFormat::Keep,
        "jpeg" => OutputFormat::Jpeg,
        _ => {
            eprintln!("{usage}");
            std::process::exit(2);
        }
    };
    let output_dir = PathBuf::from(next());
    let inputs: Vec<PathBuf> = args.map(PathBuf::from).collect();
    let options = CompressOptions {
        quality,
        max_side,
        format,
        output_dir,
    };
    let started = std::time::Instant::now();
    match compress_photos(&inputs, &options, &JobContext::detached()) {
        Ok(report) => {
            for file in &report.files {
                match (&file.output, &file.error) {
                    (Some(out), _) => println!(
                        "ok   {} -> {} ({} -> {} bytes{}{})",
                        file.source.display(),
                        out.display(),
                        file.original_bytes.unwrap_or(0),
                        file.output_bytes.unwrap_or(0),
                        if file.resized { ", resized" } else { "" },
                        if file.kept_original {
                            ", kept original"
                        } else {
                            ""
                        },
                    ),
                    (None, Some(err)) => {
                        println!("fail {}: [{}] {}", file.source.display(), err.code(), err)
                    }
                    _ => {}
                }
            }
            println!(
                "{} ok, {} failed, {} -> {} bytes in {:?}",
                report.succeeded,
                report.failed,
                report.original_bytes,
                report.output_bytes,
                started.elapsed()
            );
        }
        Err(err) => {
            eprintln!("[{}] {}", err.code(), err);
            std::process::exit(1);
        }
    }
}
