//! The app's font library for Canvas PDF: `.ttf` and `.otf` files the user
//! adds, kept inside the app's data folder (nothing is installed in the
//! system) and used first when text is rewritten or stamped.
//!
//! The folder holds the font files and `fonts.json`, an index from an id to
//! `{family, full_name, filename, weight, bold, italic}`. The layout is the one
//! the Python backend used, so fonts added by an earlier version are listed and
//! usable, and the Python stamper still reads what is added here until it is
//! replaced. The rules that decide what a font is called (family, weight,
//! italic) and which face is nearest to a request are ported unchanged from
//! `backend/core/font_library.py`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};

pub const MAX_FONT_BYTES: u64 = 20 * 1024 * 1024;
const INDEX_FILE: &str = "fonts.json";
const MAGIC: &[&[u8; 4]] = &[b"\x00\x01\x00\x00", b"true", b"ttcf", b"OTTO"];

/// Weight words, in the order they are looked for in a letters-only name:
/// longer words first, so "semibold" is not read as "bold".
const WEIGHT_WORDS: &[(&str, i32)] = &[
    ("extralight", 200),
    ("ultralight", 200),
    ("semibold", 600),
    ("demibold", 600),
    ("extrabold", 800),
    ("ultrabold", 800),
    ("thin", 100),
    ("light", 300),
    ("medium", 500),
    ("bold", 700),
    ("black", 900),
    ("heavy", 900),
];

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid pattern"))
}

fn style_suffix() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(
        &CELL,
        r"(?i)(?:[\s_-]+(?:regular|roman|normal|thin|extra\s*light|light|medium|semi\s*bold|demi\s*bold|bold|extra\s*bold|black|italic|oblique))+$",
    )
}

fn optical_size_suffix() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(&CELL, r"(?i)[\s_-]+\d+(?:\.\d+)?pt$")
}

fn italic_word() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(&CELL, r"(?i)\b(?:italic|oblique)\b")
}

fn unsafe_stem() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(&CELL, r"[^A-Za-z0-9_-]+")
}

/// What the editor needs to know about a stored font.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontInfo {
    pub id: String,
    pub family: String,
    pub filename: String,
    pub weight: i32,
    pub bold: bool,
    pub italic: bool,
}

/// One index entry. Older indexes lack some fields, which is why most are
/// optional: [`entry_identity`] knows the three generations.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct IndexEntry {
    #[serde(default)]
    family: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    full_name: Option<String>,
    #[serde(default)]
    filename: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    weight: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    italic: Option<bool>,
}

type Index = BTreeMap<String, IndexEntry>;

/// Lower-case letters and digits only, for comparing family names.
pub fn normalize_family(name: &str) -> String {
    name.chars()
        .flat_map(char::to_lowercase)
        .filter(|c| matches!(c, 'a'..='z' | '0'..='9'))
        .collect()
}

/// `OS/2.usWeightClass` of a TrueType/OpenType font (the first font of a
/// collection), when it is 1 to 1000.
pub fn sfnt_weight_class(data: &[u8]) -> Option<i32> {
    if data.len() < 12 {
        return None;
    }
    let be16 = |at: usize| {
        data.get(at..at + 2)
            .map(|b| u16::from_be_bytes([b[0], b[1]]) as usize)
    };
    let be32 = |at: usize| {
        data.get(at..at + 4)
            .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize)
    };
    let mut font_offset = 0usize;
    if &data[..4] == b"ttcf" {
        if data.len() < 16 || be32(8)? < 1 {
            return None;
        }
        font_offset = be32(12)?;
    }
    if font_offset + 12 > data.len() {
        return None;
    }
    let tables = be16(font_offset + 4)?;
    let records = font_offset + 12;
    for index in 0..tables {
        let record = records + index * 16;
        if record + 16 > data.len() {
            return None;
        }
        let (table_offset, table_length) = (be32(record + 8)?, be32(record + 12)?);
        if &data[record..record + 4] != b"OS/2" || table_length < 6 || table_offset + 6 > data.len()
        {
            continue;
        }
        let weight = be16(table_offset + 4)? as i32;
        return (1..=1000).contains(&weight).then_some(weight);
    }
    None
}

fn named_weight_value(full_name: &str) -> Option<i32> {
    let compact: String = full_name
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|c| c.is_ascii_lowercase())
        .collect();
    WEIGHT_WORDS
        .iter()
        .find(|(word, _)| compact.contains(word))
        .map(|&(_, value)| value)
}

/// Splits a face name such as `Inter 18pt Bold Italic` into the family the
/// editor selects (`Inter`), the weight and whether it is italic. The weight
/// comes from a word in the name first, then from the font's own weight class,
/// then from the bold flag.
pub fn font_identity(
    full_name: &str,
    bold_flag: bool,
    italic_flag: bool,
    data: Option<&[u8]>,
) -> (String, i32, bool) {
    let underscored = full_name.replace('_', " ");
    let name = underscored.split_whitespace().collect::<Vec<_>>().join(" ");
    let weight = named_weight_value(&name)
        .or_else(|| data.and_then(sfnt_weight_class))
        .unwrap_or(if bold_flag { 700 } else { 400 });
    let italic = italic_flag || italic_word().is_match(&name);
    let trim = |text: &str| {
        text.trim_matches(|c| c == ' ' || c == '-' || c == '_')
            .to_string()
    };
    let family = trim(&style_suffix().replace(&name, ""));
    let family = trim(&optical_size_suffix().replace(&family, ""));
    let family = if !family.is_empty() {
        family
    } else if !name.is_empty() {
        name
    } else {
        "Custom Font".to_string()
    };
    (family, weight, italic)
}

fn entry_identity(entry: &IndexEntry) -> (String, i32, bool) {
    if let (Some(weight), Some(italic)) = (entry.weight, entry.italic) {
        let named = entry.full_name.as_deref().and_then(named_weight_value);
        return (
            entry.family.clone(),
            named.unwrap_or(weight.clamp(1, 1000) as i32),
            italic,
        );
    }
    if let (Some(bold), Some(italic)) = (entry.bold, entry.italic) {
        return (entry.family.clone(), if bold { 700 } else { 400 }, italic);
    }
    font_identity(&entry.family, false, false, None)
}

/// Why a font cannot be stored, or what it is called.
struct Probe {
    full_name: String,
    bold: bool,
    italic: bool,
}

/// The face name MuPDF gives a font: family and style from the name table
/// (typographic names first), like `Crimson Pro Italic`.
fn face_name(data: &[u8]) -> Option<String> {
    let face = ttf_parser::Face::parse(data, 0).ok()?;
    // English first, like FreeType: Windows US English, Mac English, any
    // Unicode name, then whatever the font has.
    let rank = |n: &ttf_parser::name::Name| match (n.platform_id, n.language_id) {
        (ttf_parser::PlatformId::Windows, 0x0409) => 0,
        (ttf_parser::PlatformId::Macintosh, 0) => 1,
        (ttf_parser::PlatformId::Windows, _) | (ttf_parser::PlatformId::Unicode, _) => 2,
        _ => 3,
    };
    let text = |id: u16| {
        let mut names: Vec<_> = face
            .names()
            .into_iter()
            .filter(|n| n.name_id == id)
            .collect();
        names.sort_by_key(rank);
        names
            .iter()
            .filter_map(|n| n.to_string())
            .find(|s| !s.trim().is_empty())
    };
    let family =
        text(ttf_parser::name_id::TYPOGRAPHIC_FAMILY).or_else(|| text(ttf_parser::name_id::FAMILY));
    let style = text(ttf_parser::name_id::TYPOGRAPHIC_SUBFAMILY)
        .or_else(|| text(ttf_parser::name_id::SUBFAMILY));
    match (family, style) {
        (Some(family), Some(style)) => Some(format!("{family} {style}")),
        (Some(family), None) => Some(family),
        _ => text(ttf_parser::name_id::FULL_NAME)
            .or_else(|| text(ttf_parser::name_id::POST_SCRIPT_NAME)),
    }
}

/// Checks the bytes the way the old library did, and reads the font's name and
/// style flags.
fn probe(data: &[u8]) -> Result<Probe, String> {
    if data.is_empty() {
        return Err("Font file is empty.".into());
    }
    if data.len() as u64 > MAX_FONT_BYTES {
        return Err("Font file exceeds the 20 MB limit.".into());
    }
    if !MAGIC.iter().any(|magic| data.starts_with(*magic)) {
        return Err("File is not a valid TTF/OTF font.".into());
    }
    let name = face_name(data);
    // MuPDF is what draws the text later, so it must accept the font.
    let font = mupdf::Font::from_bytes(name.as_deref().unwrap_or("font"), data)
        .map_err(|e| format!("Font could not be parsed: {e}"))?;
    let Some(full_name) = name else {
        return Err("Font has no readable family name.".into());
    };
    Ok(Probe {
        full_name,
        bold: font.is_bold(),
        italic: font.is_italic(),
    })
}

/// The folder where the Python backend kept its fonts, which the library keeps
/// using so both read the same files: `~/PDFManager/data/fonts`.
pub fn default_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let home = std::env::var_os(var)
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())?;
    Some(home.join("PDFManager").join("data").join("fonts"))
}

/// A folder of fonts and its index. Calls from different threads take turns.
pub struct FontLibrary {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl FontLibrary {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            lock: Mutex::new(()),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn index_path(&self) -> PathBuf {
        self.dir.join(INDEX_FILE)
    }

    fn read_index(&self) -> Index {
        let Ok(text) = fs::read_to_string(self.index_path()) else {
            return Index::new();
        };
        serde_json::from_str(&text).unwrap_or_else(|_| {
            // Keep what is there: the next save would otherwise overwrite it.
            let _ = fs::copy(self.index_path(), self.dir.join("fonts.json.unreadable"));
            Index::new()
        })
    }

    /// Writes through a temporary file, so a crash cannot leave half an index.
    fn write_index(&self, index: &Index) -> CoreResult<()> {
        let text = serde_json::to_string_pretty(index)
            .map_err(|e| CoreError::Internal(format!("font index: {e}")))?;
        let temp = self.dir.join(format!("{INDEX_FILE}.tmp"));
        fs::write(&temp, text).map_err(|e| CoreError::io(&temp, e))?;
        fs::rename(&temp, self.index_path()).map_err(|e| {
            let _ = fs::remove_file(&temp);
            CoreError::io(self.index_path(), e)
        })
    }

    fn ensure_dir(&self) -> CoreResult<()> {
        fs::create_dir_all(&self.dir).map_err(|e| CoreError::io(&self.dir, e))
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The path of a stored file, only when the index names a plain file name.
    fn file_of(&self, entry: &IndexEntry) -> Option<PathBuf> {
        let name = Path::new(&entry.filename);
        (name.file_name() == Some(name.as_os_str())).then(|| self.dir.join(name))
    }

    pub fn list(&self) -> Vec<FontInfo> {
        let _turn = self.guard();
        self.read_index()
            .iter()
            .map(|(id, entry)| {
                let (family, weight, italic) = entry_identity(entry);
                FontInfo {
                    id: id.clone(),
                    family,
                    filename: entry.filename.clone(),
                    weight,
                    bold: weight >= 700,
                    italic,
                }
            })
            .collect()
    }

    /// Adds the font file at `path`. A name that is taken gets `-2`, `-3`, ...;
    /// the same file added twice is stored twice.
    pub fn add(&self, path: &Path) -> CoreResult<FontInfo> {
        let size = fs::metadata(path)
            .map_err(|e| CoreError::io(path, e))?
            .len();
        if size > MAX_FONT_BYTES {
            return Err(CoreError::InvalidInput(
                "Font file exceeds the 20 MB limit.".into(),
            ));
        }
        let data = fs::read(path).map_err(|e| CoreError::io(path, e))?;
        let original = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        self.add_bytes(&data, &original)
    }

    pub fn add_bytes(&self, data: &[u8], original_filename: &str) -> CoreResult<FontInfo> {
        let probed = probe(data).map_err(CoreError::InvalidInput)?;
        let original = Path::new(original_filename);
        let stem = original
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "font".into());
        let stem = if stem.is_empty() {
            "font".to_string()
        } else {
            stem
        };
        let safe = unsafe_stem()
            .replace_all(&stem, "-")
            .trim_matches('-')
            .to_string();
        let safe = if safe.is_empty() {
            "custom-font".to_string()
        } else {
            safe
        };
        let extension = match original
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
        {
            Some(ext) if ext == "ttf" || ext == "otf" => format!(".{ext}"),
            _ if data.starts_with(b"OTTO") => ".otf".to_string(),
            _ => ".ttf".to_string(),
        };

        let _turn = self.guard();
        self.ensure_dir()?;
        let mut index = self.read_index();
        let (mut id, mut filename, mut counter) = (safe.clone(), format!("{safe}{extension}"), 2);
        while self.dir.join(&filename).exists() || index.contains_key(&id) {
            id = format!("{safe}-{counter}");
            filename = format!("{safe}-{counter}{extension}");
            counter += 1;
        }
        let target = self.dir.join(&filename);
        fs::write(&target, data).map_err(|e| CoreError::io(&target, e))?;

        let (family, weight, italic) =
            font_identity(&probed.full_name, probed.bold, probed.italic, Some(data));
        index.insert(
            id.clone(),
            IndexEntry {
                family: family.clone(),
                full_name: Some(probed.full_name),
                filename: filename.clone(),
                weight: Some(weight as i64),
                bold: Some(weight >= 700),
                italic: Some(italic),
            },
        );
        if let Err(err) = self.write_index(&index) {
            let _ = fs::remove_file(&target);
            return Err(err);
        }
        Ok(FontInfo {
            id,
            family,
            filename,
            weight,
            bold: weight >= 700,
            italic,
        })
    }

    /// Removes a font and its file. Returns whether the id existed.
    pub fn remove(&self, id: &str) -> CoreResult<bool> {
        let _turn = self.guard();
        let mut index = self.read_index();
        let Some(entry) = index.remove(id) else {
            return Ok(false);
        };
        if let Some(file) = self.file_of(&entry) {
            let _ = fs::remove_file(file);
        }
        self.write_index(&index)?;
        Ok(true)
    }

    /// The bytes of a stored font, for the preview in the editor.
    pub fn read(&self, id: &str) -> CoreResult<Option<Vec<u8>>> {
        let _turn = self.guard();
        let index = self.read_index();
        let Some(file) = index.get(id).and_then(|e| self.file_of(e)) else {
            return Ok(None);
        };
        match fs::read(&file) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(CoreError::io(file, e)),
        }
    }

    /// The nearest stored face of `family` for the requested style: an italic
    /// match first, then the smallest weight difference, then the heavier face
    /// when the request is 500 or more (the lighter one below that).
    pub fn resolve(
        &self,
        family: &str,
        bold: bool,
        italic: bool,
        weight: Option<i32>,
    ) -> Option<PathBuf> {
        let (requested, _, _) = font_identity(family, false, false, None);
        let base = normalize_family(&requested);
        if base.is_empty() {
            return None;
        }
        let wanted = weight
            .unwrap_or(if bold { 700 } else { 400 })
            .clamp(1, 1000);
        let _turn = self.guard();
        let index = self.read_index();
        index
            .values()
            .filter_map(|entry| {
                let (entry_family, entry_weight, entry_italic) = entry_identity(entry);
                if normalize_family(&entry_family) != base {
                    return None;
                }
                let path = self.file_of(entry)?;
                path.exists().then_some((entry_weight, entry_italic, path))
            })
            .min_by_key(|(entry_weight, entry_italic, _)| {
                let tie_break = if wanted >= 500 {
                    -entry_weight
                } else {
                    *entry_weight
                };
                (
                    i32::from(*entry_italic != italic),
                    (entry_weight - wanted).abs(),
                    tie_break,
                )
            })
            .map(|(_, _, path)| path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(name: &str, bold: bool, italic: bool) -> (String, i32, bool) {
        font_identity(name, bold, italic, None)
    }

    #[test]
    fn identity_separates_the_family_from_the_style() {
        assert_eq!(
            identity("Roboto Regular", false, false),
            ("Roboto".into(), 400, false)
        );
        assert_eq!(
            identity("Open Sans Bold Italic", true, true),
            ("Open Sans".into(), 700, true)
        );
        assert_eq!(
            identity("Inter 18pt Bold", true, false),
            ("Inter".into(), 700, false)
        );
        assert_eq!(
            identity("Noto Sans Italic", false, true),
            ("Noto Sans".into(), 400, true)
        );
        assert_eq!(
            identity("Montserrat SemiBold", true, false),
            ("Montserrat".into(), 600, false)
        );
        assert_eq!(
            identity("Some_Font_Light", false, false),
            ("Some Font".into(), 300, false)
        );
        assert_eq!(
            identity("", false, false),
            ("Custom Font".into(), 400, false)
        );
        assert_eq!(identity("Bold", false, false), ("Bold".into(), 700, false));
    }

    /// A font file that is nothing but a header and an `OS/2` table with this weight.
    fn sfnt_with_weight(weight: u16) -> Vec<u8> {
        let mut data = b"\x00\x01\x00\x00".to_vec();
        data.extend_from_slice(&[0, 1, 0, 0, 0, 0, 0, 0]);
        data.extend_from_slice(b"OS/2");
        data.extend_from_slice(&0u32.to_be_bytes());
        data.extend_from_slice(&28u32.to_be_bytes());
        data.extend_from_slice(&6u32.to_be_bytes());
        data.extend_from_slice(&[0, 0, 0, 0]);
        data.extend_from_slice(&weight.to_be_bytes());
        data
    }

    #[test]
    fn the_fonts_own_weight_class_is_used_unless_the_name_says_otherwise() {
        let data = sfnt_with_weight(550);
        assert_eq!(
            font_identity("Example Sans Regular", false, false, Some(&data)),
            ("Example Sans".into(), 550, false)
        );
        let thin = sfnt_with_weight(250);
        assert_eq!(
            font_identity("Poppins Thin", false, false, Some(&thin)),
            ("Poppins".into(), 100, false)
        );
        assert_eq!(sfnt_weight_class(&sfnt_with_weight(0)), None);
        assert_eq!(sfnt_weight_class(&sfnt_with_weight(1001)), None);
        assert_eq!(sfnt_weight_class(b"short"), None);
    }

    #[test]
    fn family_names_compare_by_letters_and_digits() {
        assert_eq!(normalize_family("Open-Sans  2"), "opensans2");
        assert_eq!(normalize_family("ÄÖ"), "");
    }

    #[test]
    fn bytes_that_are_not_a_font_are_refused_with_a_reason() {
        let message = |data: &[u8]| probe(data).err().unwrap_or_default();
        assert_eq!(message(b""), "Font file is empty.");
        assert_eq!(
            message(b"MZ\x90\x00 not a font"),
            "File is not a valid TTF/OTF font."
        );
        assert_eq!(
            message(&vec![b'x'; 21 * 1024 * 1024]),
            "Font file exceeds the 20 MB limit."
        );
        assert!(message(&sfnt_with_weight(400)).starts_with("Font could not be parsed"));
    }

    fn library_with(entries: &[(&str, &str, i64, bool, &str)]) -> (tempfile::TempDir, FontLibrary) {
        let dir = tempfile::tempdir().unwrap();
        let library = FontLibrary::new(dir.path());
        let mut index = Index::new();
        for (id, family, weight, italic, file) in entries {
            fs::write(dir.path().join(file), b"fixture").unwrap();
            index.insert(
                id.to_string(),
                IndexEntry {
                    family: family.to_string(),
                    full_name: None,
                    filename: file.to_string(),
                    weight: Some(*weight),
                    bold: Some(*weight >= 700),
                    italic: Some(*italic),
                },
            );
        }
        library.write_index(&index).unwrap();
        (dir, library)
    }

    fn resolved(
        library: &FontLibrary,
        family: &str,
        bold: bool,
        italic: bool,
        weight: Option<i32>,
    ) -> Option<String> {
        library
            .resolve(family, bold, italic, weight)
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
    }

    #[test]
    fn the_nearest_face_wins() {
        let (_dir, library) = library_with(&[
            ("regular", "Example Sans", 400, false, "regular.ttf"),
            ("medium", "Example Sans", 500, false, "medium.ttf"),
            ("bold", "Example Sans", 700, false, "bold.ttf"),
            (
                "medium-italic",
                "Example Sans",
                500,
                true,
                "medium-italic.ttf",
            ),
        ]);
        assert_eq!(
            resolved(&library, "Example Sans", false, false, None).as_deref(),
            Some("regular.ttf")
        );
        assert_eq!(
            resolved(&library, "Example Sans", true, false, None).as_deref(),
            Some("bold.ttf")
        );
        assert_eq!(
            resolved(&library, "example-sans", false, false, Some(500)).as_deref(),
            Some("medium.ttf")
        );
        // Italic matters before weight.
        assert_eq!(
            resolved(&library, "Example Sans", true, true, None).as_deref(),
            Some("medium-italic.ttf")
        );
        // 600 is as far from 500 as from 700; the heavier wins at 500 and above.
        assert_eq!(
            resolved(&library, "Example Sans", false, false, Some(600)).as_deref(),
            Some("bold.ttf")
        );
        // Closer wins whatever the direction.
        assert_eq!(
            resolved(&library, "Example Sans", false, false, Some(450)).as_deref(),
            Some("regular.ttf")
        );
        assert_eq!(resolved(&library, "Other", false, false, None), None);
        assert_eq!(resolved(&library, "", false, false, None), None);
    }

    #[test]
    fn a_face_whose_file_is_gone_is_not_chosen() {
        let (dir, library) = library_with(&[
            ("a", "Gone", 400, false, "a.ttf"),
            ("b", "Gone", 700, false, "b.ttf"),
        ]);
        fs::remove_file(dir.path().join("b.ttf")).unwrap();
        assert_eq!(
            resolved(&library, "Gone", true, false, None).as_deref(),
            Some("a.ttf")
        );
    }

    #[test]
    fn older_index_entries_are_still_understood() {
        let dir = tempfile::tempdir().unwrap();
        let library = FontLibrary::new(dir.path());
        fs::write(dir.path().join("a.ttf"), b"x").unwrap();
        fs::write(dir.path().join("b.ttf"), b"x").unwrap();
        fs::write(dir.path().join("c.ttf"), b"x").unwrap();
        fs::write(
            library.index_path(),
            r#"{
              "a": {"family": "Old Bold", "filename": "a.ttf", "bold": true, "italic": false},
              "b": {"family": "Oldest Light Italic", "filename": "b.ttf"},
              "c": {"family": "Named", "full_name": "Named Thin", "filename": "c.ttf", "weight": 400, "bold": false, "italic": true}
            }"#,
        )
        .unwrap();
        let listed: Vec<(String, String, i32, bool, bool)> = library
            .list()
            .into_iter()
            .map(|f| (f.id, f.family, f.weight, f.bold, f.italic))
            .collect();
        assert_eq!(
            listed,
            [
                ("a".into(), "Old Bold".into(), 700, true, false),
                ("b".into(), "Oldest".into(), 300, false, true),
                // The word in the full name overrides the stored weight.
                ("c".into(), "Named".into(), 100, false, true),
            ]
        );
    }

    #[test]
    fn an_unreadable_index_is_kept_aside_and_the_library_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let library = FontLibrary::new(dir.path());
        fs::write(library.index_path(), "{ not json").unwrap();
        assert!(library.list().is_empty());
        assert_eq!(
            fs::read_to_string(dir.path().join("fonts.json.unreadable")).unwrap(),
            "{ not json"
        );
    }

    #[test]
    fn removing_and_reading_only_touch_plain_file_names() {
        let (dir, library) = library_with(&[("a", "A", 400, false, "a.ttf")]);
        assert_eq!(library.read("a").unwrap().as_deref(), Some(&b"fixture"[..]));
        assert_eq!(library.read("missing").unwrap(), None);
        let outside = dir
            .path()
            .parent()
            .unwrap()
            .join("dokuwu-outside-font-test.ttf");
        fs::write(&outside, b"secret").unwrap();
        let mut index = library.read_index();
        index.get_mut("a").unwrap().filename = "../dokuwu-outside-font-test.ttf".into();
        library.write_index(&index).unwrap();
        assert_eq!(library.read("a").unwrap(), None);
        assert!(library.remove("a").unwrap());
        assert!(
            outside.exists(),
            "a file outside the library is never deleted"
        );
        fs::remove_file(outside).unwrap();
        assert!(!library.remove("a").unwrap());
    }
}
