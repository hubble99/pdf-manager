//! Command-line runner for Extract pages, with peak memory.
//!
//!   extract_pages <pdf> <out-dir> <combine|separate_page|separate_range|split_all> [page-ranges]

use std::path::PathBuf;
use std::time::Instant;

use dokuwu_core::job::JobContext;
use dokuwu_core::ops::pdf_extract::{extract, ExtractMode, ExtractOptions};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 3 {
        eprintln!("usage: extract_pages <pdf> <out-dir> <combine|separate_page|separate_range|split_all> [page-ranges]");
        std::process::exit(2);
    }
    let mode = match args[2].as_str() {
        "combine" => ExtractMode::Combine,
        "separate_page" => ExtractMode::SeparatePage,
        "separate_range" => ExtractMode::SeparateRange,
        "split_all" => ExtractMode::SplitAll,
        other => {
            eprintln!("unknown mode {other}");
            std::process::exit(2);
        }
    };
    let options = ExtractOptions {
        mode,
        page_ranges: args.get(3).cloned().unwrap_or_default(),
        output_dir: PathBuf::from(&args[1]),
        output_name: None,
        flush_after_bytes: None,
    };
    let sink: dokuwu_core::ProgressSink = std::sync::Arc::new(|_, p| {
        if p.total.is_some_and(|t| p.done % 100 == 0 || p.done == t) {
            eprintln!("{} {}/{}  rss {} MiB", p.stage, p.done, p.total.unwrap_or(0), status_kb("VmRSS:") >> 10);
        }
    });
    let ctx = JobContext::new(1, Default::default(), Some(sink));
    let started = Instant::now();
    match extract(&PathBuf::from(&args[0]), &options, &ctx) {
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
