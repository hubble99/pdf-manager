//! Which PDF images can be re-encoded as JPEG, and the re-encode itself.
//!
//! The rules are deliberately conservative: an image is touched only when it is
//! an ordinary 8-bit grey or RGB picture. Anything JPEG cannot carry over
//! faithfully (stencil masks, colour-key masks, inverted or remapped samples,
//! palettes, spot colours, CMYK, Lab, 1-bit scans, JPEG 2000) is left exactly as
//! it is, because a wrong re-encode shows up as black or inverted objects.
//!
//! The image keeps its colour space entry, so an ICC profile or a calibrated
//! space still applies to the new samples, and its soft mask (transparency)
//! stays attached because the image object is edited in place.

use mupdf::pdf::{PdfDocument, PdfObject};
use mupdf::Buffer;

/// Images with less stored data than this are not worth a quality loss.
pub const MIN_STORED_BYTES: u64 = 2048;

/// JPEG stores width and height in 16 bits.
const MAX_SIDE: i64 = u16::MAX as i64;

/// Filters mupdf can undo before we see the samples. Anything else (CCITT,
/// JBIG2, JPX, Crypt) means the image is not an ordinary picture.
const PLAIN_FILTERS: &[&[u8]] = &[
    b"ASCIIHexDecode",
    b"ASCII85Decode",
    b"LZWDecode",
    b"FlateDecode",
    b"RunLengthDecode",
    b"DCTDecode",
];

/// A candidate image, described by its dictionary only; no pixels are read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageSpec {
    pub xref: i32,
    pub width: u32,
    pub height: u32,
    /// 1 (grey) or 3 (RGB).
    pub components: u8,
    /// Bytes the image stream occupies in the file today.
    pub stored_len: u64,
}

impl ImageSpec {
    /// Size of the decoded samples.
    pub fn sample_bytes(&self) -> u64 {
        self.width as u64 * self.height as u64 * self.components as u64
    }
}

/// What a scan learned about one object.
pub enum Scanned {
    /// Not an image, or an image we leave alone.
    Skip,
    Image {
        spec: Option<ImageSpec>,
        /// The xref of the image's soft mask, if it has one.
        soft_mask: Option<i32>,
    },
}

/// Inspects object `xref`. Errors from a damaged object are treated as "skip".
pub fn scan_object(doc: &PdfDocument, xref: i32) -> Scanned {
    scan_inner(doc, xref).unwrap_or(Scanned::Skip)
}

fn scan_inner(doc: &PdfDocument, xref: i32) -> Result<Scanned, mupdf::Error> {
    // Everything below goes through the indirect reference: MuPDF can only tell
    // that an object is a stream, and read its stream, by its object number.
    let obj = doc.new_indirect(xref, 0)?;
    if !obj.is_stream()? {
        return Ok(Scanned::Skip);
    }
    if name_of(&obj, "Subtype")?.as_deref() != Some(b"Image".as_slice()) {
        return Ok(Scanned::Skip);
    }

    let soft_mask = match obj.get_dict("SMask")? {
        Some(m) if m.is_indirect()? => Some(m.as_indirect()?),
        _ => None,
    };
    let spec = image_spec(&obj, xref)?;
    Ok(Scanned::Image { spec, soft_mask })
}

fn image_spec(dict: &PdfObject, xref: i32) -> Result<Option<ImageSpec>, mupdf::Error> {
    // Stencil, colour-key and explicit masks, and remapped samples.
    if let Some(mask) = dict.get_dict("ImageMask")? {
        if mask.is_bool()? && mask.as_bool()? {
            return Ok(None);
        }
    }
    for key in ["Mask", "Decode"] {
        if dict.get_dict(key)?.is_some() {
            return Ok(None);
        }
    }
    if int_of(dict, "BitsPerComponent")? != Some(8) {
        return Ok(None);
    }
    let Some(components) = colour_components(dict)? else { return Ok(None) };
    if !filters_are_plain(dict)? {
        return Ok(None);
    }

    let (Some(w), Some(h)) = (int_of(dict, "Width")?, int_of(dict, "Height")?) else {
        return Ok(None);
    };
    if !(1..=MAX_SIDE).contains(&w) || !(1..=MAX_SIDE).contains(&h) {
        return Ok(None);
    }
    let stored_len = match int_of(dict, "Length")? {
        Some(n) if n >= 0 => n as u64,
        // A missing or broken /Length: read the raw stream once to measure it.
        _ => dict.read_raw_stream()?.len() as u64,
    };
    if stored_len < MIN_STORED_BYTES {
        return Ok(None);
    }
    Ok(Some(ImageSpec {
        xref,
        width: w as u32,
        height: h as u32,
        components,
        stored_len,
    }))
}

/// 1 or 3 for grey and RGB spaces, `None` for everything JPEG cannot hold.
fn colour_components(dict: &PdfObject) -> Result<Option<u8>, mupdf::Error> {
    let Some(cs) = dict.get_dict("ColorSpace")? else { return Ok(None) };
    if cs.is_name()? {
        return Ok(match cs.as_name()?.as_slice() {
            b"DeviceGray" | b"CalGray" => Some(1),
            b"DeviceRGB" | b"CalRGB" => Some(3),
            _ => None,
        });
    }
    if !cs.is_array()? || cs.len()? == 0 {
        return Ok(None);
    }
    let Some(family) = cs.get_array(0)? else { return Ok(None) };
    if !family.is_name()? {
        return Ok(None);
    }
    Ok(match family.as_name()?.as_slice() {
        b"CalGray" => Some(1),
        b"CalRGB" => Some(3),
        b"ICCBased" => {
            let n = cs.get_array(1)?.map(|profile| int_of(&profile, "N")).transpose()?.flatten();
            match n {
                Some(1) => Some(1),
                Some(3) => Some(3),
                _ => None,
            }
        }
        _ => None,
    })
}

fn filters_are_plain(dict: &PdfObject) -> Result<bool, mupdf::Error> {
    let Some(filter) = dict.get_dict("Filter")? else { return Ok(true) };
    let mut names = Vec::new();
    if filter.is_name()? {
        names.push(filter.as_name()?);
    } else if filter.is_array()? {
        for i in 0..filter.len()? {
            match filter.get_array(i as i32)? {
                Some(f) if f.is_name()? => names.push(f.as_name()?),
                _ => return Ok(false),
            }
        }
    } else {
        return Ok(false);
    }
    Ok(names.iter().all(|n| PLAIN_FILTERS.contains(&n.as_slice())))
}

fn name_of(dict: &PdfObject, key: &str) -> Result<Option<Vec<u8>>, mupdf::Error> {
    match dict.get_dict(key)? {
        Some(v) if v.is_name()? => Ok(Some(v.as_name()?)),
        _ => Ok(None),
    }
}

fn int_of(dict: &PdfObject, key: &str) -> Result<Option<i64>, mupdf::Error> {
    match dict.get_dict(key)? {
        Some(v) if v.is_number()? => Ok(Some(v.as_int()? as i64)),
        _ => Ok(None),
    }
}

/// Re-encodes decoded samples as a baseline JPEG. Returns `None` when the
/// result is not smaller than what the file stores today, so a file never grows.
pub fn encode_if_smaller(
    samples: &[u8],
    spec: &ImageSpec,
    quality: u8,
) -> Result<Option<Vec<u8>>, String> {
    if samples.len() as u64 != spec.sample_bytes() {
        return Err(format!(
            "image {} has {} bytes of samples, expected {}",
            spec.xref,
            samples.len(),
            spec.sample_bytes()
        ));
    }
    let color = match spec.components {
        1 => jpeg_encoder::ColorType::Luma,
        _ => jpeg_encoder::ColorType::Rgb,
    };
    let mut out = Vec::with_capacity((spec.stored_len as usize).min(32 * 1024 * 1024));
    let mut encoder = jpeg_encoder::Encoder::new(&mut out, quality);
    encoder.set_optimized_huffman_tables(true);
    // 4:2:0 chroma subsampling, the usual choice for photos and what the old
    // Python engine (Pillow) produced.
    encoder.set_sampling_factor(jpeg_encoder::SamplingFactor::F_2_2);
    encoder
        .encode(samples, spec.width as u16, spec.height as u16, color)
        .map_err(|e| e.to_string())?;
    if out.len() as u64 >= spec.stored_len {
        return Ok(None);
    }
    Ok(Some(out))
}

/// Replaces image `xref`'s stream with `jpeg` and points its filter at DCT.
/// Everything else in the dictionary (size, colour space, soft mask) stays.
pub fn apply_jpeg(doc: &PdfDocument, xref: i32, jpeg: &[u8]) -> Result<(), mupdf::Error> {
    // The stream is updated through the indirect reference: MuPDF needs the
    // object number to record the change.
    let mut obj = doc.new_indirect(xref, 0)?;
    let buf = Buffer::from_bytes(jpeg)?;
    obj.write_raw_stream_buffer(&buf)?;
    obj.dict_put("Filter", PdfObject::new_name("DCTDecode")?)?;
    obj.dict_delete("DecodeParms")?;
    Ok(())
}
