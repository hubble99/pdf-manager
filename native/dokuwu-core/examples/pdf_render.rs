//! Render one page to a PNG and print the facts, for manual checks and for
//! `scripts/pdf_render_parity.py`.
//!
//!     cargo run --release --example pdf_render -- in.pdf out.png [page] [dpi] [low|auto|high]
//!     cargo run --release --example pdf_render -- in.pdf out.png [page] [dpi] editor
//!     cargo run --release --example pdf_render -- in.pdf --info
//!     cargo run --release --example pdf_render -- in.pdf --pages-meta [dpi]
//!
//! `editor` renders the way the Canvas editor does (72..500 dpi, 60 megapixel
//! ceiling); `--pages-meta` prints the sizes of all pages as JSON.

use std::path::PathBuf;

use dokuwu_core::ops::pdf_render::{pages_meta, pdf_info, QualityHint, RenderDocument};

fn main() {
    let mut args = std::env::args().skip(1);
    let input: PathBuf = args.next().expect("input.pdf").into();
    let second = args.next().expect("out.png or --info");
    let result = if second == "--info" {
        pdf_info(&input).map(|info| println!("{}", serde_json::to_string_pretty(&info).unwrap()))
    } else if second == "--pages-meta" {
        let dpi: u32 = args.next().map(|d| d.parse().expect("dpi")).unwrap_or(200);
        pages_meta(&input, dpi).map(|meta| println!("{}", serde_json::to_string(&meta).unwrap()))
    } else {
        let page: u32 = args.next().map(|p| p.parse().expect("page")).unwrap_or(1);
        let dpi: u32 = args.next().map(|d| d.parse().expect("dpi")).unwrap_or(72);
        let mode = args.next().unwrap_or_else(|| "auto".into());
        let hint = QualityHint::parse(&mode);
        RenderDocument::open(&input).and_then(|doc| {
            if mode == "editor" { doc.render_editor(page, dpi) } else { doc.render(page, dpi, hint) }
        }).and_then(|rendered| {
            std::fs::write(&second, &rendered.png).map_err(|e| dokuwu_core::CoreError::io(&second, e))?;
            println!("{} {} {}", rendered.width, rendered.height, rendered.dpi);
            if let Some(kb) = peak_rss_kb() {
                println!("peak memory: {:.1} MiB", kb as f64 / 1024.0);
            }
            Ok(())
        })
    };
    if let Err(err) = result {
        eprintln!("failed: {} ({})", err, err.code());
        std::process::exit(1);
    }
}

/// Peak resident memory of this process (Linux), from /proc.
fn peak_rss_kb() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}
