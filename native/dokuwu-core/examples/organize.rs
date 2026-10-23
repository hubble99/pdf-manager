//! Organize from the command line, for manual checks and for
//! `tests/fixtures/organize/parity.py`.
//!
//!     cargo run --release --example organize -- thumbs in.pdf START COUNT WIDTH OUT_DIR
//!     cargo run --release --example organize -- assemble OUT_DIR refs.json file1 [file2 ...]
//!
//! `refs.json` is a list of `{"source": 0, "page": 1, "rotation": 0, "flip": false}`
//! where `source` counts the files given after it.

use std::path::{Path, PathBuf};

use dokuwu_core::job::JobContext;
use dokuwu_core::ops::organize::{assemble, AssembleOptions, OrganizeRegistry, PageRef};
use dokuwu_core::ops::pdf_render::RenderService;
use dokuwu_core::CoreError;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("thumbs") if args.len() == 6 => thumbs(&args[1..]),
        Some("assemble") if args.len() >= 4 => assembly(&args[1..]),
        _ => {
            eprintln!("usage: organize thumbs FILE START COUNT WIDTH OUT_DIR | organize assemble OUT_DIR refs.json FILE...");
            std::process::exit(2);
        }
    };
    if let Err(err) = result {
        eprintln!("failed: {} ({})", err, err.code());
        std::process::exit(1);
    }
}

fn thumbs(args: &[String]) -> Result<(), CoreError> {
    let registry = OrganizeRegistry::new();
    let render = RenderService::new();
    let doc = registry.open(Path::new(&args[0]))?;
    let number = |text: &str| text.parse::<u32>().expect("a number");
    let batch = registry.thumbnails(&render, &doc.document_id, number(&args[1]), number(&args[2]), number(&args[3]))?;
    let out = PathBuf::from(&args[4]);
    for page in &batch.pages {
        std::fs::write(out.join(format!("page_{}.png", page.page)), &page.png).map_err(|e| CoreError::io(&out, e))?;
        println!("{} {} {}", page.page, page.width, page.height);
    }
    Ok(())
}

fn assembly(args: &[String]) -> Result<(), CoreError> {
    let refs_text = std::fs::read_to_string(&args[1]).map_err(|e| CoreError::io(&args[1], e))?;
    let refs: Vec<serde_json::Value> = serde_json::from_str(&refs_text).expect("refs.json");
    let registry = OrganizeRegistry::new();
    let ids: Vec<String> = args[2..].iter().map(|f| registry.open(Path::new(f)).map(|d| d.document_id)).collect::<Result<_, _>>()?;
    let refs: Vec<PageRef> = refs
        .iter()
        .map(|r| PageRef {
            source: ids[r["source"].as_u64().expect("source") as usize].clone(),
            page: r["page"].as_u64().unwrap_or(1) as u32,
            rotation: r["rotation"].as_i64().unwrap_or(0) as i32,
            flip: r["flip"].as_bool().unwrap_or(false),
        })
        .collect();
    let sources = registry.sources_for(&refs)?;
    let options = AssembleOptions { output_dir: PathBuf::from(&args[0]), output_name: Some("organized".into()), flush_after_bytes: None };
    let report = assemble(&sources, &refs, &options, &JobContext::detached())?;
    println!("{} {} {}", report.output_path.display(), report.pages, report.output_size_bytes);
    if let Some(kb) = peak_rss_kb() {
        println!("peak memory: {:.1} MiB", kb as f64 / 1024.0);
    }
    Ok(())
}

/// Peak resident memory of this process (Linux), from /proc.
fn peak_rss_kb() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}
