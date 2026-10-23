//! Choosing the font a text object is drawn with.
//!
//! Layered like the old backend: the app's font library first, then the
//! Windows font folder, then the built-in Helvetica. No synthetic bold is
//! applied; when a face for the request does not exist the nearest one (or the
//! built-in font) is used as it is.

use std::path::PathBuf;
use std::sync::OnceLock;

use mupdf::Font;
use regex::Regex;

use crate::ops::font_library::FontLibrary;

/// Where fonts are looked for.
pub struct FontSources<'a> {
    pub library: Option<&'a FontLibrary>,
    /// The Windows fonts folder; `None` when there is none (other systems).
    pub system_dir: Option<PathBuf>,
}

impl<'a> FontSources<'a> {
    pub fn new(library: Option<&'a FontLibrary>) -> Self {
        let windir = std::env::var_os("WINDIR").map(PathBuf::from);
        let system_dir = if cfg!(windows) {
            Some(windir.unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join("Fonts"))
        } else {
            windir.map(|w| w.join("Fonts"))
        };
        Self { library, system_dir }
    }
}

/// A font ready to measure and to draw with.
pub struct LoadedFont {
    pub font: Font,
    /// The file the font was read from; `None` for the built-in Helvetica.
    pub data: Option<Vec<u8>>,
}

fn subset_prefix() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z]{6}\+").unwrap())
}

fn style_suffix() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:[-_,\s]?(?:bolditalic|boldoblique|semibolditalic|semibold|demibold|bold|italic|oblique|regular|roman|medium|light|black|book|bi|bd|it)(?:mt)?)$",
        )
        .unwrap()
    })
}

fn compact(text: &str) -> String {
    text.to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect()
}

fn alias(compact: &str) -> Option<&'static str> {
    Some(match compact {
        "arial" | "arialps" => "Arial",
        "calibri" => "Calibri",
        "cambria" => "Cambria",
        "couriernew" | "couriernewps" => "Courier New",
        "georgia" => "Georgia",
        "tahoma" => "Tahoma",
        "timesnewroman" | "timesnewromanps" => "Times New Roman",
        "trebuchetms" => "Trebuchet MS",
        "verdana" => "Verdana",
        _ => return None,
    })
}

/// Strips a subset prefix and PostScript style markers and gives a family
/// name ("ABCDEF+Arial-BoldMT" is "Arial").
pub fn canonical_family(font_name: &str) -> String {
    let stripped = subset_prefix().replace(font_name.trim(), "").into_owned();
    if let Some(found) = alias(&compact(&stripped)) {
        return found.to_string();
    }
    let trim_set = |c: char| matches!(c, '-' | '_' | ',' | ' ');
    let mut family = stripped;
    loop {
        let next = style_suffix().replace(&family, "").trim_end_matches(trim_set).to_string();
        if next == family {
            break;
        }
        family = next;
    }
    let family = Regex::new(r"(?i)MT$").unwrap().replace(&family, "").trim_end_matches(trim_set).to_string();
    match alias(&compact(&family)) {
        Some(found) => found.to_string(),
        None if family.is_empty() => "Helvetica".to_string(),
        None => family,
    }
}

/// File names to look for in the Windows fonts folder, best first.
pub fn system_candidates(family: &str, bold: bool, italic: bool, weight: Option<i32>) -> Vec<String> {
    let requested = weight.unwrap_or(if bold { 700 } else { 400 }).clamp(1, 1000);
    let normalized = canonical_family(family).to_lowercase();
    let available: &[i32] = if normalized == "calibri" { &[300, 400, 700] } else { &[400, 700] };
    // Closest weight; a tie goes to the heavier face from 500 up.
    let system_weight = *available
        .iter()
        .min_by_key(|&&v| ((v - requested).abs(), if requested >= 500 { -v } else { v }))
        .expect("never empty");
    let system_bold = system_weight >= 700;
    let suffix = if system_bold && italic {
        "bi"
    } else if system_bold {
        "bd"
    } else if italic {
        "i"
    } else {
        ""
    };
    let b_i = |plain: &str, bi: &str, b: &str, i: &str| -> String {
        if system_bold && italic {
            bi.into()
        } else if system_bold {
            b.into()
        } else if italic {
            i.into()
        } else {
            plain.into()
        }
    };
    let known = match normalized.as_str() {
        "arial" => Some(format!("arial{suffix}.ttf")),
        "calibri" => Some(if system_weight == 300 {
            if italic { "calibrili.ttf".to_string() } else { "calibril.ttf".to_string() }
        } else {
            format!("calibri{}.ttf", b_i("", "z", "b", "i"))
        }),
        "cambria" => Some(if !system_bold && !italic {
            "cambria.ttc".to_string()
        } else {
            format!("cambria{}.ttf", if system_bold && italic { "z" } else if system_bold { "b" } else { "i" })
        }),
        "times new roman" => Some(format!("times{suffix}.ttf")),
        "courier new" => Some(format!("cour{suffix}.ttf")),
        "georgia" => Some(format!("georgia{}.ttf", b_i("", "z", "b", "i"))),
        "verdana" => Some(format!("verdana{}.ttf", b_i("", "z", "b", "i"))),
        // Windows ships no italic Tahoma; keep the family with its plain or bold face.
        "tahoma" => Some(format!("tahoma{}.ttf", if system_bold { "bd" } else { "" })),
        "trebuchet ms" => Some(format!("trebuc{}.ttf", b_i("", "bi", "bd", "it"))),
        "century gothic" => Some(format!("gothic{}.ttf", b_i("", "bi", "b", "i"))),
        _ => None,
    };
    let compact = compact(&normalized);
    let requested_name = if compact.is_empty() { format!("arial{suffix}.ttf") } else { format!("{compact}{suffix}.ttf") };
    let plain = if compact.is_empty() { "arial.ttf".to_string() } else { format!("{compact}.ttf") };
    vec![known.unwrap_or(requested_name), plain, "arial.ttf".to_string()]
}

/// Library font, then Windows font, then Helvetica.
pub fn load_font(sources: &FontSources<'_>, family: &str, bold: bool, italic: bool, weight: Option<i32>) -> LoadedFont {
    if let Some(library) = sources.library {
        let canonical = canonical_family(family);
        let path = library
            .resolve(family, bold, italic, weight)
            .or_else(|| library.resolve(&canonical, bold, italic, weight));
        if let Some(loaded) = path.and_then(|p| from_file(&p)) {
            return loaded;
        }
    }
    if let Some(dir) = &sources.system_dir {
        for name in system_candidates(&canonical_family(family), bold, italic, weight) {
            let path = dir.join(&name);
            if path.is_file() {
                if let Some(loaded) = from_file(&path) {
                    return loaded;
                }
            }
        }
    }
    LoadedFont { font: Font::new("Helvetica").expect("the built-in Helvetica always loads"), data: None }
}

fn from_file(path: &std::path::Path) -> Option<LoadedFont> {
    let data = std::fs::read(path).ok()?;
    let name = path.file_stem()?.to_string_lossy().into_owned();
    let font = Font::from_bytes(&name, &data).ok()?;
    Some(LoadedFont { font, data: Some(data) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn families_lose_subset_prefixes_and_style_words() {
        assert_eq!(canonical_family("ABCDEF+Arial-BoldMT"), "Arial");
        assert_eq!(canonical_family("TimesNewRomanPS-BoldItalicMT"), "Times New Roman");
        assert_eq!(canonical_family("Calibri-Light"), "Calibri");
        assert_eq!(canonical_family("Roboto-Medium"), "Roboto");
        assert_eq!(canonical_family("Poppins SemiBold Italic"), "Poppins");
        assert_eq!(canonical_family("  "), "Helvetica");
        assert_eq!(canonical_family("Italiana"), "Italiana");
    }

    #[test]
    fn windows_file_names_follow_the_old_table() {
        assert_eq!(system_candidates("Arial", false, false, None)[0], "arial.ttf");
        assert_eq!(system_candidates("Arial", true, true, None)[0], "arialbi.ttf");
        assert_eq!(system_candidates("Arial", false, false, Some(600))[0], "arialbd.ttf");
        assert_eq!(system_candidates("Calibri", false, false, Some(300))[0], "calibril.ttf");
        assert_eq!(system_candidates("Calibri", false, true, Some(300))[0], "calibrili.ttf");
        assert_eq!(system_candidates("Calibri", true, true, None)[0], "calibriz.ttf");
        assert_eq!(system_candidates("Cambria", false, false, None)[0], "cambria.ttc");
        assert_eq!(system_candidates("Cambria", true, false, None)[0], "cambriab.ttf");
        assert_eq!(system_candidates("Tahoma", false, true, None)[0], "tahoma.ttf");
        assert_eq!(system_candidates("Trebuchet MS", false, true, None)[0], "trebucit.ttf");
        assert_eq!(system_candidates("Century Gothic", true, false, None)[0], "gothicb.ttf");
        assert_eq!(system_candidates("Segoe UI", true, false, None), vec!["segoeuibd.ttf", "segoeui.ttf", "arial.ttf"]);
        assert_eq!(system_candidates("", false, false, None), vec!["helvetica.ttf", "helvetica.ttf", "arial.ttf"]);
    }

    #[test]
    fn a_missing_family_falls_back_to_the_built_in_font() {
        let sources = FontSources { library: None, system_dir: None };
        let loaded = load_font(&sources, "Nonexistent Family", false, false, None);
        assert!(loaded.data.is_none());
    }
}
