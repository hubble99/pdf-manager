//! Command-line runner for Merge PDF, with peak memory.
//!
//!   merge_pdfs <out-dir> <strict|skip> <pdf>...

use std::path::PathBuf;
use std::time::Instant;

use dokuwu_core::job::JobContext;
use dokuwu_core::ops::pdf_merge::{merge, MergeOptions};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 4 {
        eprintln!("usage: merge_pdfs <out-dir> <strict|skip> <pdf>...");
        std::process::exit(2);
    }
    let options = MergeOptions { skip_invalid: args[1] == "skip", output_dir: PathBuf::from(&args[0]), output_name: None, flush_after_bytes: None };
    let paths: Vec<PathBuf> = args[2..].iter().map(PathBuf::from).collect();
    let sink: dokuwu_core::ProgressSink = std::sync::Arc::new(|_, p| {
        if p.total.is_some_and(|t| p.done % 5 == 0 || p.done == t) {
            eprintln!("{} {}/{}  rss {} MiB", p.stage, p.done, p.total.unwrap_or(0), status_kb("VmRSS:") >> 10);
        }
    });
    let ctx = JobContext::new(1, Default::default(), Some(sink));
    let started = Instant::now();
    match merge(&paths, &options, &ctx) {
        Ok(report) => {
            println!("{report:#?}");
            println!("took {:.1} s, peak memory {} MiB", started.elapsed().as_secs_f64(), status_kb("VmHWM:") >> 10);
        }
        Err(err) => {
            eprintln!("failed: {err} ({})", err.code());
            std::process::exit(1);
        }
    }
}

fn status_kb(key: &str) -> u64 {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    status
        .lines()
        .find(|l| l.starts_with(key))
        .and_then(|l| l.split_whitespace().nth(1)?.parse().ok())
        .unwrap_or(0)
}
