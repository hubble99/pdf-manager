//! Command-line runner for Protect PDF, with peak memory.
//!
//!   protect_pdf add <pdf> <out-dir> <user-pw> [owner-pw] [--no-print] [--no-copy] [--no-modify]
//!   protect_pdf remove <pdf> <out-dir> <password>

use std::path::PathBuf;
use std::time::Instant;

use dokuwu_core::job::JobContext;
use dokuwu_core::ops::pdf_protect::{protect, remove_password, ProtectOptions, UnprotectOptions};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flags: Vec<&String> = args.iter().filter(|a| a.starts_with("--")).collect();
    let args: Vec<String> = args.iter().filter(|a| !a.starts_with("--")).cloned().collect();
    if args.len() < 4 {
        eprintln!("usage: protect_pdf add <pdf> <out-dir> <user-pw> [owner-pw] [--no-print] [--no-copy] [--no-modify]\n       protect_pdf remove <pdf> <out-dir> <password>");
        std::process::exit(2);
    }
    let input = PathBuf::from(&args[1]);
    let output_dir = PathBuf::from(&args[2]);
    let ctx = JobContext::detached();
    let started = Instant::now();
    let result = match args[0].as_str() {
        "add" => protect(
            &input,
            &ProtectOptions {
                user_password: args[3].clone(),
                owner_password: args.get(4).cloned().unwrap_or_default(),
                allow_print: !flags.iter().any(|f| f.as_str() == "--no-print"),
                allow_copy: !flags.iter().any(|f| f.as_str() == "--no-copy"),
                allow_modify: !flags.iter().any(|f| f.as_str() == "--no-modify"),
                output_dir,
                output_name: None,
            },
            &ctx,
        ),
        "remove" => remove_password(&input, &UnprotectOptions { password: args[3].clone(), output_dir, output_name: None }, &ctx),
        other => {
            eprintln!("unknown command {other}");
            std::process::exit(2);
        }
    };
    match result {
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
