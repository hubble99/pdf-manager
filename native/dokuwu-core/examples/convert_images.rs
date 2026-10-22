//! Command-line runner for PDF to image and image to PDF, with peak memory.
//!
//!   convert_images pdf2img <pdf> <out-dir> <png|jpeg|webp> <dpi> [page-ranges]
//!   convert_images img2pdf <out-dir> <page-size> <image>...

use std::path::PathBuf;
use std::time::Instant;

use dokuwu_core::job::JobContext;
use dokuwu_core::ops::image_to_pdf::{images_to_pdf, ImageInput, ImageToPdfOptions};
use dokuwu_core::ops::pdf_to_image::{pdf_to_images, ImageFormat, PdfToImageOptions};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let started = Instant::now();
    let result = match args.first().map(String::as_str) {
        Some("pdf2img") if args.len() >= 5 => {
            let format = match args[3].as_str() {
                "png" => ImageFormat::Png,
                "jpeg" | "jpg" => ImageFormat::Jpeg,
                "webp" => ImageFormat::Webp,
                other => return usage(&format!("unknown format {other}")),
            };
            let options = PdfToImageOptions {
                format,
                dpi: args[4].parse().unwrap_or(150),
                page_ranges: args.get(5).cloned().unwrap_or_default(),
                output_dir: PathBuf::from(&args[2]),
                output_name: None,
            };
            let ctx = progress_context();
            pdf_to_images(&PathBuf::from(&args[1]), &options, &ctx).map(|r| format!("{r:#?}"))
        }
        Some("img2pdf") if args.len() >= 4 => {
            let options = ImageToPdfOptions { page_size: args[2].clone(), output_dir: PathBuf::from(&args[1]), output_name: None };
            let images: Vec<ImageInput> = args[3..]
                .iter()
                .map(|p| ImageInput { path: PathBuf::from(p), rotation: 0, flip_h: false })
                .collect();
            let ctx = progress_context();
            images_to_pdf(&images, &options, &ctx).map(|r| format!("{r:#?}"))
        }
        _ => return usage("missing arguments"),
    };
    match result {
        Ok(report) => {
            println!("{report}");
            println!("took {:.1} s", started.elapsed().as_secs_f64());
            if let Some(kb) = peak_rss_kb() {
                println!("peak memory: {:.1} MiB", kb as f64 / 1024.0);
            }
        }
        Err(err) => {
            eprintln!("failed: {err} ({})", err.code());
            std::process::exit(1);
        }
    }
}

fn progress_context() -> JobContext {
    let sink: dokuwu_core::ProgressSink = std::sync::Arc::new(|_, p| {
        if p.total.is_some_and(|t| p.done % 50 == 0 || p.done == t) {
            eprintln!("{} {}/{}", p.stage, p.done, p.total.unwrap_or(0));
        }
    });
    JobContext::new(1, dokuwu_core::CancelToken::new(), Some(sink)).with_min_interval(std::time::Duration::ZERO)
}

fn usage(why: &str) {
    eprintln!("{why}\nusage:\n  convert_images pdf2img <pdf> <out-dir> <png|jpeg|webp> <dpi> [page-ranges]\n  convert_images img2pdf <out-dir> <page-size> <image>...");
    std::process::exit(2);
}

fn peak_rss_kb() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}
