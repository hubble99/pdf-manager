//! Writes a QR code or barcode to a file, for a quick look or to scan with a phone.
//!
//!   cargo run --example qr_barcode -- qr <text> <out.png|out.svg> [size] [level] [border]
//!   cargo run --example qr_barcode -- barcode <code128|ean13|ean8|code39> <text> <out.png|out.svg>

use std::path::Path;

use dokuwu_core::ops::{barcode, qr};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let usage = "usage: qr <text> <out> [size] [level] [border] | barcode <type> <text> <out>";
    let result = match args.first().map(String::as_str) {
        Some("qr") if args.len() >= 3 => {
            let out = &args[2];
            let size = args.get(3).map_or(10, |s| s.parse().expect("size"));
            let level = args.get(4).map_or("M", String::as_str);
            let border = args
                .get(5)
                .map_or(qr::DEFAULT_BORDER, |s| s.parse().expect("border"));
            qr::generate(&args[1], size, level, extension(out), border).map(|g| (out, g))
        }
        Some("barcode") if args.len() >= 4 => {
            let out = &args[3];
            barcode::generate(&args[2], &args[1], extension(out)).map(|g| (out, g))
        }
        _ => panic!("{usage}"),
    };
    match result {
        Ok((out, image)) => {
            std::fs::write(out, &image.bytes).expect("write output");
            println!("{out}: {} bytes ({})", image.bytes.len(), image.mime);
        }
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    }
}

fn extension(path: &str) -> &str {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
}
