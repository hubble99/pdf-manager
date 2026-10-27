//! Writes a .docx package page by page.
//!
//! Images go into the ZIP as soon as a page is done and the document body is
//! appended to a temporary file, so memory use does not grow with the page
//! count. The XML follows the element order of the OOXML schema, which Word
//! (unlike most other readers) enforces.

use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use flate2::write::DeflateEncoder;
use flate2::Compression;

use super::layout::{line_multiple, Align, Background, Band, Cell, ImageItem, Item, PageLayout, Para, Run, Table, VAlign, VMerge};
use super::model::{half_points, EncodedImage};
use crate::error::{CoreError, CoreResult};

const NS_DOC: &str = concat!(
    r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" "#,
    r#"xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" "#,
    r#"xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" "#,
    r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" "#,
    r#"xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture""#
);

fn twips(pt: f32) -> i64 {
    (pt * 20.0).round() as i64
}

fn emu(pt: f32) -> i64 {
    (pt * 12700.0).round() as i64
}

/// Escapes text for XML and drops characters XML 1.0 cannot carry.
pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\t' | '\n' | '\r' => out.push(c),
            c if (c as u32) < 0x20 || c == '\u{fffe}' || c == '\u{ffff}' => {}
            c => out.push(c),
        }
    }
    out
}

/// Maps a PDF font name to the font Word should use: drops the subset
/// prefix and style suffix, maps the standard PDF fonts to the Windows
/// equivalents, and spaces out CamelCase family names ("BookAntiqua").
pub fn word_font(pdf_name: &str) -> String {
    let mut name = pdf_name;
    if let Some((prefix, rest)) = name.split_once('+') {
        if prefix.len() == 6 && prefix.chars().all(|c| c.is_ascii_uppercase()) {
            name = rest;
        }
    }
    let family = name.split([',', '-']).next().unwrap_or(name).trim();
    let mut family = family.to_string();
    for suffix in ["PSMT", "MT", "PS", "Std", "Pro"] {
        if family.len() > suffix.len() + 2 && family.ends_with(suffix) {
            family.truncate(family.len() - suffix.len());
            break;
        }
    }
    let lower = family.to_ascii_lowercase().replace(' ', "");
    let mapped = match lower.as_str() {
        "" => "Arial",
        "helvetica" | "arial" | "liberationsans" | "arimo" | "nimbussans" | "helveticaneue" => "Arial",
        "times" | "timesroman" | "timesnewroman" | "liberationserif" | "tinos" | "nimbusroman" => "Times New Roman",
        "courier" | "couriernew" | "liberationmono" | "cousine" | "nimbusmono" => "Courier New",
        "symbol" => "Symbol",
        "zapfdingbats" | "dingbats" => "Wingdings",
        _ => "",
    };
    if !mapped.is_empty() {
        return mapped.to_string();
    }
    // "SegoeUI" -> "Segoe UI", "BookAntiqua" -> "Book Antiqua".
    let mut spaced = String::new();
    let chars: Vec<char> = family.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if i > 0 && c.is_ascii_uppercase() && chars[i - 1].is_ascii_lowercase() {
            spaced.push(' ');
        }
        spaced.push(c);
    }
    spaced
}

// ── ZIP ──────────────────────────────────────────────────────────────────────

struct ZipEntry {
    name: String,
    crc: u32,
    csize: u32,
    usize: u32,
    offset: u32,
}

struct Zip {
    out: BufWriter<File>,
    pos: u64,
    entries: Vec<ZipEntry>,
}

/// A fixed timestamp (2026-01-01 00:00) keeps output reproducible.
const DOS_TIME: u16 = 0;
const DOS_DATE: u16 = ((2026 - 1980) << 9) | (1 << 5) | 1;

impl Zip {
    fn new(file: File) -> Self {
        Self { out: BufWriter::new(file), pos: 0, entries: Vec::new() }
    }

    fn io(&self, e: std::io::Error) -> CoreError {
        CoreError::Internal(format!("writing docx: {e}"))
    }

    /// Streams `reader` into a deflated entry, then patches sizes and CRC
    /// into the local header.
    fn add_reader(&mut self, name: &str, mut reader: impl Read) -> CoreResult<()> {
        if self.pos > u32::MAX as u64 {
            return Err(CoreError::Unsupported("document is larger than 4 GB".into()));
        }
        let header_pos = self.pos;
        self.write_local_header(name, 0, 0, 0).map_err(|e| self.io(e))?;
        let data_start = self.pos;
        let mut crc = crc32fast::Hasher::new();
        let mut usize: u64 = 0;
        {
            let mut enc = DeflateEncoder::new(&mut self.out, Compression::default());
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = reader.read(&mut buf).map_err(|e| CoreError::Internal(format!("writing docx: {e}")))?;
                if n == 0 {
                    break;
                }
                crc.update(&buf[..n]);
                usize += n as u64;
                enc.write_all(&buf[..n]).map_err(|e| CoreError::Internal(format!("writing docx: {e}")))?;
            }
            enc.finish().map_err(|e| CoreError::Internal(format!("writing docx: {e}")))?;
        }
        self.out.flush().map_err(|e| self.io(e))?;
        let end = self.out.get_mut().stream_position().map_err(|e| self.io(e))?;
        let csize = end - data_start;
        if csize > u32::MAX as u64 || usize > u32::MAX as u64 {
            return Err(CoreError::Unsupported("document part is larger than 4 GB".into()));
        }
        let crc = crc.finalize();
        // Patch CRC and sizes (offset 14 in the local header).
        let file = self.out.get_mut();
        file.seek(SeekFrom::Start(header_pos + 14)).map_err(|e| CoreError::Internal(format!("writing docx: {e}")))?;
        let mut patch = Vec::with_capacity(12);
        patch.extend_from_slice(&crc.to_le_bytes());
        patch.extend_from_slice(&(csize as u32).to_le_bytes());
        patch.extend_from_slice(&(usize as u32).to_le_bytes());
        file.write_all(&patch).map_err(|e| CoreError::Internal(format!("writing docx: {e}")))?;
        file.seek(SeekFrom::Start(end)).map_err(|e| CoreError::Internal(format!("writing docx: {e}")))?;
        self.pos = end;
        self.entries.push(ZipEntry { name: name.into(), crc, csize: csize as u32, usize: usize as u32, offset: header_pos as u32 });
        Ok(())
    }

    fn add(&mut self, name: &str, data: &[u8]) -> CoreResult<()> {
        self.add_reader(name, data)
    }

    fn write_local_header(&mut self, name: &str, crc: u32, csize: u32, usize: u32) -> std::io::Result<()> {
        let mut h = Vec::with_capacity(30 + name.len());
        h.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        h.extend_from_slice(&20u16.to_le_bytes()); // version needed
        h.extend_from_slice(&0u16.to_le_bytes()); // flags
        h.extend_from_slice(&8u16.to_le_bytes()); // deflate
        h.extend_from_slice(&DOS_TIME.to_le_bytes());
        h.extend_from_slice(&DOS_DATE.to_le_bytes());
        h.extend_from_slice(&crc.to_le_bytes());
        h.extend_from_slice(&csize.to_le_bytes());
        h.extend_from_slice(&usize.to_le_bytes());
        h.extend_from_slice(&(name.len() as u16).to_le_bytes());
        h.extend_from_slice(&0u16.to_le_bytes());
        h.extend_from_slice(name.as_bytes());
        self.out.write_all(&h)?;
        self.pos += h.len() as u64;
        Ok(())
    }

    fn finish(mut self) -> CoreResult<()> {
        let cd_start = self.pos;
        let mut cd = Vec::new();
        for e in &self.entries {
            cd.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            cd.extend_from_slice(&20u16.to_le_bytes()); // made by
            cd.extend_from_slice(&20u16.to_le_bytes()); // needed
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&8u16.to_le_bytes());
            cd.extend_from_slice(&DOS_TIME.to_le_bytes());
            cd.extend_from_slice(&DOS_DATE.to_le_bytes());
            cd.extend_from_slice(&e.crc.to_le_bytes());
            cd.extend_from_slice(&e.csize.to_le_bytes());
            cd.extend_from_slice(&e.usize.to_le_bytes());
            cd.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
            cd.extend_from_slice(&[0u8; 8]); // extra, comment, disk, internal attrs
            cd.extend_from_slice(&0u32.to_le_bytes()); // external attrs
            cd.extend_from_slice(&e.offset.to_le_bytes());
            cd.extend_from_slice(e.name.as_bytes());
        }
        let n = self.entries.len() as u16;
        let mut end = Vec::new();
        end.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        end.extend_from_slice(&[0u8; 4]);
        end.extend_from_slice(&n.to_le_bytes());
        end.extend_from_slice(&n.to_le_bytes());
        end.extend_from_slice(&(cd.len() as u32).to_le_bytes());
        end.extend_from_slice(&(cd_start as u32).to_le_bytes());
        end.extend_from_slice(&0u16.to_le_bytes());
        self.out.write_all(&cd).map_err(|e| CoreError::Internal(format!("writing docx: {e}")))?;
        self.out.write_all(&end).map_err(|e| CoreError::Internal(format!("writing docx: {e}")))?;
        self.out.flush().map_err(|e| CoreError::Internal(format!("writing docx: {e}")))?;
        self.out.get_ref().sync_all().map_err(|e| CoreError::Internal(format!("writing docx: {e}")))?;
        Ok(())
    }
}

// ── Document ─────────────────────────────────────────────────────────────────

pub struct DocxWriter {
    zip: Zip,
    body: BufWriter<File>,
    body_path: PathBuf,
    images: Vec<(String, String)>,
    has_png: bool,
    has_jpeg: bool,
    next_shape: u32,
    /// The sectPr of the section written last. It is placed when the next
    /// section starts, or at the end of the body.
    pending_sect: Option<String>,
    pages: usize,
}

impl DocxWriter {
    pub fn create(path: &Path) -> CoreResult<Self> {
        let file = File::create(path).map_err(|e| CoreError::io(path, e))?;
        let body_path = path.with_extension("body.part");
        let body = File::create(&body_path).map_err(|e| CoreError::io(&body_path, e))?;
        Ok(Self {
            zip: Zip::new(file),
            body: BufWriter::new(body),
            body_path,
            images: Vec::new(),
            has_png: false,
            has_jpeg: false,
            next_shape: 1,
            pending_sect: None,
            pages: 0,
        })
    }

    fn body_err(&self, e: std::io::Error) -> CoreError {
        CoreError::io(&self.body_path, e)
    }

    fn add_image(&mut self, img: &EncodedImage) -> CoreResult<String> {
        let n = self.images.len() + 1;
        let target = format!("media/image{n}.{}", img.ext);
        self.zip.add(&format!("word/{target}"), &img.bytes)?;
        match img.ext {
            "png" => self.has_png = true,
            _ => self.has_jpeg = true,
        }
        let rid = format!("rIdImg{n}");
        self.images.push((rid.clone(), target));
        Ok(rid)
    }

    /// Appends one PDF page as one or more sections.
    pub fn write_page(&mut self, layout: &PageLayout, images: &[EncodedImage], fonts: &[String]) -> CoreResult<()> {
        let mut rids = Vec::with_capacity(images.len());
        for img in images {
            rids.push(self.add_image(img)?);
        }
        let fonts: Vec<String> = fonts.iter().map(|f| word_font(f)).collect();
        let mut xml = String::new();
        let mut first = true;
        for (bi, band) in layout.bands.iter().enumerate() {
            if let Some(sect) = self.pending_sect.take() {
                xml.push_str(&format!(
                    r#"<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr>{sect}</w:pPr></w:p>"#
                ));
            }
            let mut w = BodyWriter { xml: &mut xml, rids: &rids, fonts: &fonts, next_shape: &mut self.next_shape };
            if first && !layout.backgrounds.is_empty() {
                w.backgrounds(&layout.backgrounds, images);
            }
            w.band(band);
            self.pending_sect = Some(sect_pr(layout, band, if bi == 0 { "nextPage" } else { "continuous" }));
            first = false;
        }
        self.body.write_all(xml.as_bytes()).map_err(|e| self.body_err(e))?;
        self.pages += 1;
        Ok(())
    }

    pub fn finish(mut self, title: &str) -> CoreResult<()> {
        let tail = format!("{}</w:body></w:document>", self.pending_sect.take().unwrap_or_default());
        self.body.write_all(tail.as_bytes()).map_err(|e| self.body_err(e))?;
        self.body.flush().map_err(|e| self.body_err(e))?;
        drop(self.body);

        let head = format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {NS_DOC}><w:body>"#);
        let body_file = File::open(&self.body_path).map_err(|e| CoreError::io(&self.body_path, e))?;
        self.zip.add_reader("word/document.xml", head.as_bytes().chain(body_file))?;
        let _ = std::fs::remove_file(&self.body_path);

        let mut rels = String::from(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>"#);
        for (rid, target) in &self.images {
            rels.push_str(&format!(r#"<Relationship Id="{rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="{target}"/>"#));
        }
        rels.push_str("</Relationships>");
        self.zip.add("word/_rels/document.xml.rels", rels.as_bytes())?;

        let mut types = String::from(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>"#);
        if self.has_png {
            types.push_str(r#"<Default Extension="png" ContentType="image/png"/>"#);
        }
        if self.has_jpeg {
            types.push_str(r#"<Default Extension="jpeg" ContentType="image/jpeg"/>"#);
        }
        types.push_str(r#"<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>"#);
        self.zip.add("[Content_Types].xml", types.as_bytes())?;
        self.zip.add("_rels/.rels", ROOT_RELS.as_bytes())?;
        self.zip.add("word/styles.xml", STYLES.as_bytes())?;
        self.zip.add("word/settings.xml", SETTINGS.as_bytes())?;
        let core = format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>{}</dc:title></cp:coreProperties>"#,
            esc(title)
        );
        self.zip.add("docProps/core.xml", core.as_bytes())?;
        let app = format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Dokuwu</Application><Pages>{}</Pages></Properties>"#,
            self.pages
        );
        self.zip.add("docProps/app.xml", app.as_bytes())?;
        self.zip.finish()
    }

    /// Removes the temporary body file after a failure or cancel.
    pub fn abandon(self) {
        let path = self.body_path.clone();
        drop(self);
        let _ = std::fs::remove_file(path);
    }
}

fn sect_pr(layout: &PageLayout, band: &Band, kind: &str) -> String {
    // Word allows pages up to 22 inches on a side.
    let w = layout.width.clamp(72.0, 1584.0);
    let h = layout.height.clamp(72.0, 1584.0);
    let orient = if w > h { r#" w:orient="landscape""# } else { "" };
    let m = layout.margins;
    let cols = if band.columns.len() <= 1 {
        r#"<w:cols w:space="720"/>"#.to_string()
    } else {
        let mut s = format!(r#"<w:cols w:num="{}" w:equalWidth="0">"#, band.columns.len());
        for (i, c) in band.columns.iter().enumerate() {
            let space = band.columns.get(i + 1).map(|n| n.x0 - c.x1).unwrap_or(0.0).max(0.0);
            s.push_str(&format!(r#"<w:col w:w="{}" w:space="{}"/>"#, twips(c.x1 - c.x0), twips(space)));
        }
        s.push_str("</w:cols>");
        s
    };
    format!(
        r#"<w:sectPr><w:type w:val="{kind}"/><w:pgSz w:w="{}" w:h="{}"{orient}/><w:pgMar w:top="{}" w:right="{}" w:bottom="{}" w:left="{}" w:header="0" w:footer="0" w:gutter="0"/>{cols}</w:sectPr>"#,
        twips(w),
        twips(h),
        twips(m.top),
        twips(m.right),
        twips(m.bottom),
        twips(m.left)
    )
}

struct BodyWriter<'a> {
    xml: &'a mut String,
    rids: &'a [String],
    fonts: &'a [String],
    next_shape: &'a mut u32,
}

impl BodyWriter<'_> {
    fn band(&mut self, band: &Band) {
        for (ci, col) in band.columns.iter().enumerate() {
            let mut column_break = ci > 0;
            if column_break && !matches!(col.items.first(), Some(Item::Para(_)) | Some(Item::Image(_))) {
                self.xml.push_str(r#"<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:br w:type="column"/></w:r></w:p>"#);
                column_break = false;
            }
            self.items(&col.items, column_break);
        }
    }

    fn items(&mut self, items: &[Item], mut column_break: bool) {
        let mut prev_table = false;
        for item in items {
            match item {
                Item::Para(p) => {
                    self.para(p, column_break);
                    prev_table = false;
                }
                Item::Image(im) => {
                    self.image(im, column_break);
                    prev_table = false;
                }
                Item::Table(t) => {
                    // Two tables in a row would merge into one in Word.
                    if prev_table {
                        self.xml.push_str(r#"<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr></w:p>"#);
                    }
                    self.table(t);
                    prev_table = true;
                }
            }
            column_break = false;
        }
    }

    fn para(&mut self, p: &Para, column_break: bool) {
        let x = &mut *self.xml;
        x.push_str("<w:p><w:pPr>");
        if let Some(level) = p.heading {
            x.push_str(&format!(r#"<w:pStyle w:val="Heading{level}"/>"#));
        }
        if let Some(frame) = p.frame {
            x.push_str(&format!(
                r#"<w:framePr w:w="{}" w:hRule="auto" w:wrap="around" w:vAnchor="page" w:hAnchor="page" w:x="{}" w:y="{}"/>"#,
                twips(frame.width),
                twips(frame.x),
                twips(frame.y)
            ));
        }
        if let Some(space) = p.border_bottom {
            x.push_str(&format!(r#"<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="{}" w:color="auto"/></w:pBdr>"#, space.round() as i64));
        }
        if !p.tabs.is_empty() {
            x.push_str("<w:tabs>");
            let mut tabs: Vec<i64> = p.tabs.iter().map(|&t| twips(t)).filter(|&t| t > 0).collect();
            tabs.sort_unstable();
            tabs.dedup();
            for t in tabs {
                x.push_str(&format!(r#"<w:tab w:val="left" w:pos="{t}"/>"#));
            }
            x.push_str("</w:tabs>");
        }
        // A framed paragraph sits at its page position and takes no part in the flow.
        let (space_before, ind_left, ind_first, ind_right) = if p.frame.is_some() {
            (0.0, 0.0, 0.0, 0.0)
        } else {
            (p.space_before, p.ind_left, p.ind_first, p.ind_right)
        };
        x.push_str(&format!(r#"<w:spacing w:before="{}" w:after="0""#, twips(space_before.min(1584.0))));
        if let Some(pitch) = p.line_pitch {
            let line = (240.0 * line_multiple(pitch, p.size)).round() as i64;
            x.push_str(&format!(r#" w:line="{line}" w:lineRule="auto""#));
        }
        x.push_str("/>");
        let left = twips(ind_left);
        let first = twips(ind_first);
        let right = twips(ind_right);
        if left != 0 || first != 0 || right != 0 {
            x.push_str(&format!(r#"<w:ind w:left="{left}" w:right="{right}""#));
            if first > 0 {
                x.push_str(&format!(r#" w:firstLine="{first}""#));
            } else if first < 0 {
                x.push_str(&format!(r#" w:hanging="{}""#, -first));
            }
            x.push_str("/>");
        }
        let jc = match p.align {
            Align::Left => "left",
            Align::Center => "center",
            Align::Right => "right",
            Align::Justify => "both",
        };
        x.push_str(&format!(r#"<w:jc w:val="{jc}"/>"#));
        let hp = half_points(p.size);
        x.push_str(&format!(r#"<w:rPr><w:sz w:val="{hp}"/><w:szCs w:val="{hp}"/></w:rPr></w:pPr>"#));
        if column_break {
            x.push_str(r#"<w:r><w:br w:type="column"/></w:r>"#);
        }
        for run in &p.runs {
            self.run(run);
        }
        self.xml.push_str("</w:p>");
    }

    fn run(&mut self, run: &Run) {
        let s = &run.style;
        let font = esc(self.fonts.get(s.font as usize).map(String::as_str).unwrap_or("Arial"));
        let x = &mut *self.xml;
        x.push_str("<w:r><w:rPr>");
        x.push_str(&format!(r#"<w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:eastAsia="{font}" w:cs="{font}"/>"#));
        if s.bold {
            x.push_str("<w:b/><w:bCs/>");
        }
        if s.italic {
            x.push_str("<w:i/><w:iCs/>");
        }
        if s.strike {
            x.push_str("<w:strike/>");
        }
        if s.color != 0 {
            x.push_str(&format!(r#"<w:color w:val="{:06X}"/>"#, s.color));
        }
        let hp = half_points(s.size);
        x.push_str(&format!(r#"<w:sz w:val="{hp}"/><w:szCs w:val="{hp}"/>"#));
        if s.underline {
            x.push_str(r#"<w:u w:val="single"/>"#);
        }
        x.push_str("</w:rPr>");
        for (i, part) in run.text.split('\t').enumerate() {
            if i > 0 {
                x.push_str("<w:tab/>");
            }
            if !part.is_empty() {
                x.push_str(&format!(r#"<w:t xml:space="preserve">{}</w:t>"#, esc(part)));
            }
        }
        x.push_str("</w:r>");
    }

    fn shape_id(&mut self) -> u32 {
        let id = *self.next_shape;
        *self.next_shape += 1;
        id
    }

    fn graphic(&self, id: u32, rid: &str, cx: i64, cy: i64) -> String {
        format!(
            r#"<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{id}" name="Picture {id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>"#
        )
    }

    fn image(&mut self, im: &ImageItem, column_break: bool) {
        let Some(rid) = self.rids.get(im.image).cloned() else { return };
        let id = self.shape_id();
        let (cx, cy) = (emu(im.width).max(1), emu(im.height).max(1));
        let graphic = self.graphic(id, &rid, cx, cy);
        let jc = if im.align == Align::Center { "center" } else { "left" };
        let ind = if im.ind_left > 0.5 { format!(r#"<w:ind w:left="{}"/>"#, twips(im.ind_left)) } else { String::new() };
        let br = if column_break { r#"<w:r><w:br w:type="column"/></w:r>"# } else { "" };
        self.xml.push_str(&format!(
            r#"<w:p><w:pPr><w:spacing w:before="{}" w:after="0"/>{ind}<w:jc w:val="{jc}"/></w:pPr>{br}<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="{id}" name="Picture {id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>{graphic}</wp:inline></w:drawing></w:r></w:p>"#,
            twips(im.space_before.min(1584.0))
        ));
    }

    /// Full-page pictures with text over them: anchored to the page, behind the text.
    fn backgrounds(&mut self, bgs: &[Background], _images: &[EncodedImage]) {
        self.xml.push_str(r#"<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr>"#);
        for bg in bgs {
            let Some(rid) = self.rids.get(bg.image).cloned() else { continue };
            let id = self.shape_id();
            let (cx, cy) = (emu(bg.rect.width()).max(1), emu(bg.rect.height()).max(1));
            let graphic = self.graphic(id, &rid, cx, cy);
            self.xml.push_str(&format!(
                r#"<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="{}" behindDoc="1" locked="1" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>{}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>{}</wp:posOffset></wp:positionV><wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="{id}" name="Picture {id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>{graphic}</wp:anchor></w:drawing></w:r>"#,
                id,
                emu(bg.rect.x0),
                emu(bg.rect.y0)
            ));
        }
        self.xml.push_str("</w:p>");
    }

    fn table(&mut self, t: &Table) {
        let total: f32 = t.cols.iter().sum();
        self.xml.push_str(&format!(
            r#"<w:tbl><w:tblPr><w:tblStyle w:val="DokuwuTable"/><w:tblW w:w="{}" w:type="dxa"/><w:tblInd w:w="{}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>"#,
            twips(total),
            twips(t.ind_left)
        ));
        for c in &t.cols {
            self.xml.push_str(&format!(r#"<w:gridCol w:w="{}"/>"#, twips(*c)));
        }
        self.xml.push_str("</w:tblGrid>");
        for row in &t.rows {
            self.xml.push_str(&format!(r#"<w:tr><w:trPr><w:trHeight w:val="{}" w:hRule="atLeast"/></w:trPr>"#, twips(row.height)));
            for cell in &row.cells {
                self.cell(cell);
            }
            self.xml.push_str("</w:tr>");
        }
        self.xml.push_str("</w:tbl>");
    }

    fn cell(&mut self, c: &Cell) {
        self.xml.push_str(&format!(r#"<w:tc><w:tcPr><w:tcW w:w="{}" w:type="dxa"/>"#, twips(c.width)));
        if c.span > 1 {
            self.xml.push_str(&format!(r#"<w:gridSpan w:val="{}"/>"#, c.span));
        }
        match c.vmerge {
            VMerge::Restart => self.xml.push_str(r#"<w:vMerge w:val="restart"/>"#),
            VMerge::Continue => self.xml.push_str("<w:vMerge/>"),
            VMerge::None => {}
        }
        let va = match c.valign {
            VAlign::Top => "top",
            VAlign::Center => "center",
            VAlign::Bottom => "bottom",
        };
        self.xml.push_str(&format!(r#"<w:vAlign w:val="{va}"/></w:tcPr>"#));
        let items: Vec<&Item> = c.items.iter().filter(|i| !matches!(i, Item::Table(_))).collect();
        if items.is_empty() {
            self.xml.push_str("<w:p/>");
        }
        for item in items {
            match item {
                Item::Para(p) => self.para(p, false),
                Item::Image(im) => self.image(im, false),
                Item::Table(_) => {}
            }
        }
        self.xml.push_str("</w:tc>");
    }
}

const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>"#;

const SETTINGS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>"#;

const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:unhideWhenUsed/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="1"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:unhideWhenUsed/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="2"/></w:pPr></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style><w:style w:type="table" w:styleId="DokuwuTable"><w:name w:val="Dokuwu Table"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style></w:styles>"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn font_names_map_to_word_fonts() {
        assert_eq!(word_font("ABCDEF+Helvetica-Bold"), "Arial");
        assert_eq!(word_font("TimesNewRomanPSMT"), "Times New Roman");
        assert_eq!(word_font("ArialMT"), "Arial");
        assert_eq!(word_font("Calibri,Bold"), "Calibri");
        assert_eq!(word_font("BCDEFG+SegoeUI-Semibold"), "Segoe UI");
        assert_eq!(word_font("Courier"), "Courier New");
        assert_eq!(word_font(""), "Arial");
    }

    #[test]
    fn escape_drops_control_characters() {
        assert_eq!(esc("a<b & \u{1}c\"\u{ffff}"), "a&lt;b &amp; c&quot;");
    }
}
