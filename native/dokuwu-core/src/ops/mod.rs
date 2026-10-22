//! Operations exposed to the app. Each takes paths and a `JobContext`.

pub(crate) mod batch;
pub mod naming;
pub(crate) mod ordered;
pub mod page_ranges;
pub mod zip_stream;
pub mod checksum;
pub mod pdf_to_word;
pub mod image_convert;
pub mod photo_compress;
pub mod pdf_compress;
pub mod image_to_pdf;
pub(crate) mod pdf_writer;
pub mod pdf_render;
pub mod pdf_to_image;
