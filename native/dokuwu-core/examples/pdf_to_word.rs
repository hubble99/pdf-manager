//! Converts a PDF to .docx from the command line, for checking conversions by hand:
//! `cargo run --release --example pdf_to_word -- input.pdf output.docx`
use dokuwu_core::ops::pdf_to_word::convert_pdf_to_docx;
use dokuwu_core::JobContext;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: pdf_to_word <input.pdf> <output.docx>");
        std::process::exit(2);
    }
    match convert_pdf_to_docx(args[1].as_ref(), args[2].as_ref(), &JobContext::detached()) {
        Ok(report) => println!("{}", serde_json::to_string_pretty(&report).unwrap()),
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}
