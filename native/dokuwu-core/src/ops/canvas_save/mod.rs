//! Saving a Canvas PDF: the objects drawn in the editor become PDF content on
//! the original pages.
//!
//! The editor sends one JSON entry per page (see [`model`]); each entry is
//! stamped onto its page in the page's own, upright coordinates, scaled from the
//! editor's canvas units. A page that is turned keeps its rotation: shapes,
//! images and text are placed through the page's transform, so they appear where
//! the editor showed them. The page's existing content is wrapped in `q ... Q`
//! first, so a transform left active by the source can never move what is
//! added, and everything new goes on top in the order the editor drew it.
//!
//! The result is written to a part file and published under a free name; a
//! failure or cancel leaves nothing behind.

mod fonts;
mod image;
mod model;
mod shapes;
mod text;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use mupdf::pdf::{PdfDocument, PdfPage, PdfWriteOptions};
use mupdf::shape::Shape;
use serde::Serialize;

use crate::error::{CoreError, CoreResult};
use crate::job::JobContext;
use crate::ops::font_library::FontLibrary;
use crate::ops::naming::{create_part, sanitize_stem, PartGuard};
use crate::ops::pdf_graft::{open, path_str, save_error};

use self::fonts::FontSources;
use self::image::ImageStore;
use self::model::{parse_entries, parse_page, NativeObject, PageAnnotations, PageEntry};
use self::shapes::{err, Scale};
use self::text::FontNames;

pub use self::fonts::{canonical_family, system_candidates};

pub const STAGE_PAGES: &str = "pages";
pub const STAGE_SAVING: &str = "saving";

/// Where and how the result is written.
pub struct SaveOptions<'a> {
    pub output_dir: PathBuf,
    /// The name the user typed; `edited_document` when empty.
    pub output_name: Option<String>,
    /// The font library text is set in first; the system fonts and the built-in
    /// Helvetica follow.
    pub fonts: Option<&'a FontLibrary>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReport {
    pub output_path: PathBuf,
    pub output_size_bytes: u64,
    pub pages: u32,
    /// How many pages received something.
    pub stamped_pages: u32,
    pub duration_ms: u64,
}

fn stamp_error(page_index: usize, cause: impl std::fmt::Display) -> CoreError {
    CoreError::InvalidInput(format!("Could not stamp annotation on page index {page_index}: {cause}"))
}

/// What the stamping of one page needs from the whole document.
struct Env<'a> {
    fonts: FontSources<'a>,
    font_names: FontNames,
    images: ImageStore,
}

/// The page being stamped and the content waiting to be put on it.
struct Stamper<'p> {
    page: &'p mut PdfPage,
    pending: String,
    wrapped: bool,
}

impl Stamper<'_> {
    /// The page's own content goes inside `q ... Q` once, before anything new.
    fn wrap(&mut self, doc: &mut PdfDocument) -> Result<(), String> {
        if !self.wrapped {
            self.page.wrap_contents(doc).map_err(err)?;
            self.wrapped = true;
        }
        Ok(())
    }

    fn flush(&mut self, doc: &mut PdfDocument) -> Result<(), String> {
        if self.pending.is_empty() {
            return Ok(());
        }
        self.wrap(doc)?;
        self.page.insert_contents(doc, self.pending.as_bytes(), true).map_err(err)?;
        self.pending.clear();
        Ok(())
    }

    /// Draws with a fresh shape and queues what it produced.
    fn draw(
        &mut self,
        draw: impl FnOnce(&mut Shape<'_>) -> Result<Option<mupdf::Matrix>, String>,
    ) -> Result<(), String> {
        let mut shape = Shape::new(self.page).map_err(err)?;
        let matrix = draw(&mut shape)?;
        let content = format!("{}{}", shape.total_cont(), shape.text_cont());
        drop(shape);
        match matrix {
            Some(m) => self.pending.push_str(&text::wrap_with_matrix(&m, &content)),
            None => self.pending.push_str(&content),
        }
        Ok(())
    }
}

fn is_object_type(item: &NativeObject<'_>, kinds: &[&str]) -> bool {
    item.kind.as_deref().is_some_and(|k| kinds.contains(&k))
}

fn stamp_object(
    doc: &mut PdfDocument,
    stamper: &mut Stamper<'_>,
    env: &mut Env<'_>,
    item: &NativeObject<'_>,
    scale: Scale,
    assets: &std::collections::HashMap<String, std::borrow::Cow<'_, str>>,
    rotation: i32,
) -> Result<(), String> {
    match item.kind.as_deref() {
        Some("rect") | Some("circle") => {
            let is_rect = item.kind.as_deref() == Some("rect");
            stamper.draw(|shape| shapes::draw_rect_or_ellipse(shape, item, scale, is_rect).map(|_| None))
        }
        Some("line") => stamper.draw(|shape| shapes::draw_line(shape, item, scale).map(|_| None)),
        Some("pen") | Some("highlighter") => stamper.draw(|shape| shapes::draw_path(shape, item, scale).map(|_| None)),
        Some("text") => {
            let fonts = &env.fonts;
            let names = &mut env.font_names;
            stamper.draw(|shape| text::draw_text(shape, item, scale, fonts, names, rotation))
        }
        Some("image") => {
            let encoded = item
                .asset_id
                .as_ref()
                .and_then(|id| assets.get(id))
                .map(|c| c.as_ref())
                .or(item.src.as_deref())
                .filter(|s| !s.is_empty());
            let Some(encoded) = encoded else {
                return Err(format!("Image object {} has no image data.", item.id.as_deref().unwrap_or("")));
            };
            let corners = image::image_corners(item, scale)?;
            let width = f64::from(corners[0].x - corners[1].x).hypot(f64::from(corners[0].y - corners[1].y));
            let height = f64::from(corners[0].x - corners[3].x).hypot(f64::from(corners[0].y - corners[3].y));
            if width < 0.01 || height < 0.01 {
                return Ok(());
            }
            let raw = image::decode_image_data(encoded)?;
            let key = image::content_key(&raw);
            let bytes = image::prepare_image_stream(raw)?;
            let opacity = item.opacity.unwrap_or(1.0).clamp(0.0, 1.0) as f32;
            stamper.flush(doc)?;
            stamper.wrap(doc)?;
            image::place_image(doc, stamper.page, &mut env.images, &key, &bytes, &corners, opacity)
        }
        _ => Ok(()),
    }
}

fn stamp_page(
    doc: &mut PdfDocument,
    page: &mut PdfPage,
    env: &mut Env<'_>,
    entry: PageEntry<'_>,
) -> Result<bool, String> {
    let bounds = page.bounds().map_err(err)?;
    let (page_w, page_h) = ((bounds.x1 - bounds.x0) as f64, (bounds.y1 - bounds.y0) as f64);
    let rotation = page.rotation().map_err(err)?;
    let mut stamper = Stamper { page, pending: String::new(), wrapped: false };
    let full_page = [
        mupdf::Point::new(0.0, 0.0),
        mupdf::Point::new(page_w as f32, 0.0),
        mupdf::Point::new(page_w as f32, page_h as f32),
        mupdf::Point::new(0.0, page_h as f32),
    ];

    match entry {
        PageEntry::Empty => return Ok(false),
        PageEntry::Raster(encoded) => {
            raster(doc, &mut stamper, env, &encoded, &full_page)?;
        }
        PageEntry::Page(annotations) => {
            let PageAnnotations { native_objects, shapes: legacy, canvas_width, canvas_height, image_assets, image_b64, raster_rect } = *annotations;
            let canvas_w = canvas_width.unwrap_or(page_w);
            let canvas_h = canvas_height.unwrap_or(page_h);
            if canvas_w == 0.0 || canvas_h == 0.0 {
                return Err("the canvas size must not be zero".into());
            }
            let scale = Scale { x: page_w / canvas_w, y: page_h / canvas_h };
            match &native_objects {
                Some(objects) => {
                    for item in objects {
                        stamp_object(doc, &mut stamper, env, item, scale, &image_assets, rotation)?;
                    }
                }
                None => {
                    for item in &legacy {
                        if is_object_type(item, &["rect", "circle", "line"]) {
                            stamper.draw(|shape| shapes::draw_legacy(shape, item, scale).map(|_| None))?;
                        }
                    }
                }
            }
            if let Some(encoded) = image_b64.as_deref().filter(|s| !s.is_empty()) {
                let target = match raster_rect.as_deref().and_then(model::numbers).filter(|r| r.len() == 4) {
                    Some(r) => [
                        shapes::pt(r[0] * scale.x, r[1] * scale.y),
                        shapes::pt((r[0] + r[2]) * scale.x, r[1] * scale.y),
                        shapes::pt((r[0] + r[2]) * scale.x, (r[1] + r[3]) * scale.y),
                        shapes::pt(r[0] * scale.x, (r[1] + r[3]) * scale.y),
                    ],
                    None => full_page,
                };
                raster(doc, &mut stamper, env, encoded, &target)?;
            }
        }
    }
    stamper.flush(doc)?;
    Ok(true)
}

/// Lays a picture over `target`, fitted inside it with its proportions kept.
fn raster(
    doc: &mut PdfDocument,
    stamper: &mut Stamper<'_>,
    env: &mut Env<'_>,
    encoded: &str,
    target: &[mupdf::Point; 4],
) -> Result<(), String> {
    let raw = image::decode_lenient(encoded)?;
    if raw.is_empty() {
        return Ok(());
    }
    let key = image::content_key(&raw);
    let (w, h) = image::image_size(&raw).ok_or_else(|| "Image data could not be decoded.".to_string())?;
    let rect = mupdf::Rect::new(target[0].x, target[0].y, target[2].x, target[2].y);
    let corners = image::fitted_corners(rect, (w, h));
    stamper.flush(doc)?;
    stamper.wrap(doc)?;
    image::place_image(doc, stamper.page, &mut env.images, &key, &raw, &corners, 1.0)
}

fn write_options() -> PdfWriteOptions {
    let mut write = PdfWriteOptions::default();
    write.set_garbage_level(4).set_compress(true);
    write
}

/// Stamps the annotations in `annotations_path` onto `source` and writes the
/// result into `options.output_dir`.
pub fn save_canvas(
    source: &Path,
    annotations_path: &Path,
    options: &SaveOptions<'_>,
    ctx: &JobContext,
) -> CoreResult<SaveReport> {
    let started = Instant::now();
    let bytes = fs::read(annotations_path).map_err(|e| CoreError::io(annotations_path, e))?;
    save_canvas_bytes(source, &bytes, options, ctx).map(|mut report| {
        report.duration_ms = started.elapsed().as_millis() as u64;
        report
    })
}

/// [`save_canvas`] with the annotations already in memory.
pub fn save_canvas_bytes(source: &Path, annotations: &[u8], options: &SaveOptions<'_>, ctx: &JobContext) -> CoreResult<SaveReport> {
    let started = Instant::now();
    let entries = parse_entries(annotations)?;
    if !options.output_dir.is_dir() {
        return Err(CoreError::NotFound { path: options.output_dir.clone() });
    }
    ctx.check_cancelled()?;

    let mut doc = open(source).map_err(|e| CoreError::InvalidInput(format!("Cannot open PDF: {e}")))?;
    if doc.needs_password().map_err(|e| CoreError::Internal(format!("password check: {e}")))? {
        return Err(CoreError::PasswordRequired);
    }
    let page_count = doc.page_count().map_err(|e| CoreError::Internal(format!("page count: {e}")))?.max(0) as usize;

    let base = sanitize_stem(options.output_name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or("edited_document"));
    let (file, part) = create_part(&options.output_dir, &base, "pdf").map_err(|e| CoreError::io(&options.output_dir, e))?;
    drop(file);
    let guard = PartGuard::new(part.clone());

    let mut env = Env { fonts: FontSources::new(options.fonts), font_names: FontNames::default(), images: ImageStore::default() };
    let total = entries.len() as u64;
    ctx.report(STAGE_PAGES, 0, Some(total));
    let mut stamped = 0u32;
    for (index, raw) in entries.iter().enumerate() {
        ctx.check_cancelled()?;
        if index < page_count {
            let entry = parse_page(raw).map_err(|e| stamp_error(index, e))?;
            if !matches!(entry, PageEntry::Empty) {
                let mut page = doc.load_pdf_page(index as i32).map_err(|e| stamp_error(index, e))?;
                if stamp_page(&mut doc, &mut page, &mut env, entry).map_err(|e| stamp_error(index, e))? {
                    stamped += 1;
                }
            }
        }
        ctx.report(STAGE_PAGES, index as u64 + 1, Some(total));
    }

    ctx.check_cancelled()?;
    ctx.report(STAGE_SAVING, 0, None);
    doc.save_with_options(path_str(&part)?, write_options()).map_err(|e| save_error(&part, e))?;
    drop(doc);
    ctx.check_cancelled()?;

    let output_path = guard.publish(&options.output_dir, &base, "pdf").map_err(|e| CoreError::io(&options.output_dir, e))?;
    Ok(SaveReport {
        output_size_bytes: fs::metadata(&output_path).map(|m| m.len()).unwrap_or(0),
        output_path,
        pages: page_count as u32,
        stamped_pages: stamped,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}
