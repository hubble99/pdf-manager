//! Compress a PDF from the command line and print the report and peak memory.
//!
//!     cargo run --release --example pdf_compress -- in.pdf out.pdf [quality] [batch_mib]

use std::path::PathBuf;

use dokuwu_core::job::JobContext;
use dokuwu_core::ops::pdf_compress::{compress_pdf, CompressOptions};

fn main() {
    let mut args = std::env::args().skip(1);
    let input: PathBuf = args.next().expect("input.pdf").into();
    let output: PathBuf = args.next().expect("output.pdf").into();
    let quality = args.next().map(|q| q.parse().expect("quality")).unwrap_or(70);
    let mut options = CompressOptions::new(quality);
    options.batch_bytes = args.next().map(|m| m.parse::<u64>().expect("batch MiB") * 1024 * 1024);

    let ctx = JobContext::detached();
    match compress_pdf(&input, &output, &options, &ctx) {
        Ok(report) => {
            println!("{}", serde_json::to_string_pretty(&report).unwrap());
            if let Some(kb) = peak_rss_kb() {
                println!("peak memory: {:.1} MiB", kb as f64 / 1024.0);
            }
        }
        Err(err) => {
            eprintln!("failed: {} ({})", err, err.code());
            std::process::exit(1);
        }
    }
}

/// Peak resident memory of this process (Linux), from /proc.
fn peak_rss_kb() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}
