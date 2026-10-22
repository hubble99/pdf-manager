//! Helpers shared by the integration tests.
#![allow(dead_code)]

use std::path::PathBuf;

pub struct PageSpec {
    pub media: [f32; 4],
    pub crop: Option<[f32; 4]>,
    pub rotate: i32,
    pub content: &'static str,
}

impl PageSpec {
    pub fn new(width: f32, height: f32, content: &'static str) -> Self {
        Self { media: [0.0, 0.0, width, height], crop: None, rotate: 0, content }
    }
}

/// A valid PDF with the given pages and an optional /Info title.
pub fn build_pdf(pages: &[PageSpec], title: Option<&str>) -> Vec<u8> {
    let mut objects: Vec<String> = Vec::new();
    // 1 catalog, 2 pages, 3 info, then (page, content) pairs.
    objects.push("<< /Type /Catalog /Pages 2 0 R >>".into());
    let kids: Vec<String> = (0..pages.len()).map(|i| format!("{} 0 R", 4 + i * 2)).collect();
    objects.push(format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), pages.len()));
    objects.push(match title {
        Some(t) => format!("<< /Title ({t}) /Author (Dokuwu) >>"),
        None => "<< >>".into(),
    });
    for (i, page) in pages.iter().enumerate() {
        let m = page.media;
        let mut dict = format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [{} {} {} {}] /Rotate {} /Contents {} 0 R /Resources << >>",
            m[0], m[1], m[2], m[3], page.rotate, 5 + i * 2
        );
        if let Some(c) = page.crop {
            dict.push_str(&format!(" /CropBox [{} {} {} {}]", c[0], c[1], c[2], c[3]));
        }
        dict.push_str(" >>");
        objects.push(dict);
        objects.push(format!("<< /Length {} >>\nstream\n{}\nendstream", page.content.len(), page.content));
    }
    let mut out = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", i + 1, body).as_bytes());
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for off in offsets {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!("trailer\n<< /Size {} /Root 1 0 R /Info 3 0 R >>\nstartxref\n{}\n%%EOF\n", objects.len() + 1, xref).as_bytes(),
    );
    out
}

pub fn write_pdf(dir: &tempfile::TempDir, name: &str, pages: &[PageSpec], title: Option<&str>) -> PathBuf {
    let path = dir.path().join(name);
    std::fs::write(&path, build_pdf(pages, title)).unwrap();
    path
}

pub struct Decoded {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

impl Decoded {
    pub fn pixel(&self, x: u32, y: u32) -> [u8; 3] {
        let i = ((y * self.width + x) * 3) as usize;
        [self.rgb[i], self.rgb[i + 1], self.rgb[i + 2]]
    }
}

pub fn decode(png_bytes: &[u8]) -> Decoded {
    let decoder = png::Decoder::new(std::io::Cursor::new(png_bytes));
    let mut reader = decoder.read_info().unwrap();
    let mut buf = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut buf).unwrap();
    assert_eq!(info.color_type, png::ColorType::Rgb);
    buf.truncate(info.buffer_size());
    Decoded { width: info.width, height: info.height, rgb: buf }
}

