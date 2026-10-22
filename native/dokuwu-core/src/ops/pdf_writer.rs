//! A minimal streaming PDF writer: objects are written as they are made and
//! only their byte offsets are kept, so a PDF of thousands of images never
//! sits in memory. Fits Image to PDF (one image per page); not a general writer.

use std::io::{self, Write};

/// Offsets in the classic cross-reference table have ten digits.
const MAX_OFFSET: u64 = 9_999_999_999;

pub struct PdfWriter<W: Write> {
    out: W,
    pos: u64,
    /// Offset of object `n` is `offsets[n - 1]`; objects 1 and 2 are the catalog
    /// and the page tree, written last.
    offsets: Vec<u64>,
    open: bool,
}

pub const CATALOG: u32 = 1;
pub const PAGES: u32 = 2;

impl<W: Write> PdfWriter<W> {
    pub fn new(out: W) -> io::Result<Self> {
        let mut w = Self { out, pos: 0, offsets: vec![0, 0], open: false };
        // The binary comment tells tools the file is not plain text.
        w.raw(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")?;
        Ok(w)
    }

    fn raw(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.out.write_all(bytes)?;
        self.pos += bytes.len() as u64;
        Ok(())
    }

    /// Starts a new object and returns its number.
    pub fn begin(&mut self) -> io::Result<u32> {
        debug_assert!(!self.open);
        let number = self.offsets.len() as u32 + 1;
        self.offsets.push(self.pos);
        self.open = true;
        self.raw(format!("{number} 0 obj\n").as_bytes())?;
        Ok(number)
    }

    fn begin_fixed(&mut self, number: u32) -> io::Result<()> {
        self.offsets[number as usize - 1] = self.pos;
        self.open = true;
        self.raw(format!("{number} 0 obj\n").as_bytes())
    }

    pub fn end(&mut self) -> io::Result<()> {
        self.open = false;
        self.raw(b"\nendobj\n")
    }

    /// A whole stream object: `dict_entries` are the extra dictionary entries
    /// (without `/Length`).
    pub fn stream_object(&mut self, dict_entries: &str, data: &[u8]) -> io::Result<u32> {
        let number = self.begin()?;
        self.raw(format!("<< {dict_entries} /Length {} >>\nstream\n", data.len()).as_bytes())?;
        self.raw(data)?;
        self.raw(b"\nendstream")?;
        self.end()?;
        Ok(number)
    }

    pub fn dict_object(&mut self, body: &str) -> io::Result<u32> {
        let number = self.begin()?;
        self.raw(format!("<< {body} >>").as_bytes())?;
        self.end()?;
        Ok(number)
    }

    /// Writes the page tree, the catalog, the cross-reference table and the
    /// trailer, and returns the underlying writer.
    pub fn finish(mut self, pages: &[u32], producer: &str) -> io::Result<W> {
        let info = self.dict_object(&format!("/Producer ({})", escape(producer)))?;
        let kids: String = pages.iter().map(|p| format!("{p} 0 R")).collect::<Vec<_>>().join(" ");
        self.begin_fixed(PAGES)?;
        self.raw(format!("<< /Type /Pages /Count {} /Kids [{kids}] >>", pages.len()).as_bytes())?;
        self.end()?;
        self.begin_fixed(CATALOG)?;
        self.raw(format!("<< /Type /Catalog /Pages {PAGES} 0 R >>").as_bytes())?;
        self.end()?;

        let xref_at = self.pos;
        if xref_at > MAX_OFFSET {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "the PDF is too large for a classic cross-reference table"));
        }
        let count = self.offsets.len() + 1;
        let mut table = String::with_capacity(count * 20 + 32);
        table.push_str(&format!("xref\n0 {count}\n0000000000 65535 f \n"));
        for off in &self.offsets {
            table.push_str(&format!("{off:010} 00000 n \n"));
        }
        table.push_str(&format!(
            "trailer\n<< /Size {count} /Root {CATALOG} 0 R /Info {info} 0 R >>\nstartxref\n{xref_at}\n%%EOF\n"
        ));
        self.raw(table.as_bytes())?;
        self.out.flush()?;
        Ok(self.out)
    }
}

fn escape(text: &str) -> String {
    text.replace('\\', "\\\\").replace('(', "\\(").replace(')', "\\)")
}
