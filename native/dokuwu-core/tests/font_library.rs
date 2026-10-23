//! The font library (`ops::font_library`) with real fonts (SIL OFL, see the
//! licence files next to them).

use std::path::{Path, PathBuf};

use dokuwu_core::ops::font_library::FontLibrary;

fn font(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/fonts")
        .join(name)
}

fn library() -> (tempfile::TempDir, FontLibrary) {
    let dir = tempfile::tempdir().unwrap();
    let library = FontLibrary::new(dir.path().join("fonts"));
    (dir, library)
}

#[test]
fn a_font_is_added_listed_read_and_removed() {
    let (_dir, library) = library();
    assert!(library.list().is_empty());
    let added = library.add(&font("RedHatMono-Bold.ttf")).unwrap();
    assert_eq!(
        (added.id.as_str(), added.family.as_str()),
        ("RedHatMono-Bold", "Red Hat Mono")
    );
    assert_eq!((added.weight, added.bold, added.italic), (700, true, false));
    assert!(library.dir().join(&added.filename).is_file());

    assert_eq!(library.list(), vec![added.clone()]);
    assert_eq!(
        library.read(&added.id).unwrap().unwrap(),
        std::fs::read(font("RedHatMono-Bold.ttf")).unwrap()
    );

    assert!(library.remove(&added.id).unwrap());
    assert!(!library.dir().join(&added.filename).exists());
    assert!(library.list().is_empty());
    assert!(!library.remove(&added.id).unwrap());
}

#[test]
fn the_same_file_added_again_gets_a_free_id() {
    let (_dir, library) = library();
    let first = library.add(&font("Italiana-Regular.ttf")).unwrap();
    let second = library.add(&font("Italiana-Regular.ttf")).unwrap();
    let third = library.add(&font("Italiana-Regular.ttf")).unwrap();
    assert_eq!(
        (first.id.as_str(), second.id.as_str(), third.id.as_str()),
        (
            "Italiana-Regular",
            "Italiana-Regular-2",
            "Italiana-Regular-3"
        )
    );
    assert_eq!(second.filename, "Italiana-Regular-2.ttf");
    assert_eq!(library.list().len(), 3);
}

#[test]
fn files_that_are_not_usable_fonts_are_refused_and_nothing_is_stored() {
    let (dir, library) = library();
    let refuse = |name: &str, bytes: &[u8], expect: &str| {
        let source = dir.path().join(name);
        std::fs::write(&source, bytes).unwrap();
        let err = library.add(&source).unwrap_err();
        assert_eq!(err.code(), "invalid_input", "{name}");
        assert!(err.to_string().contains(expect), "{name}: {err}");
        assert!(library.list().is_empty());
        assert!(
            !library.dir().exists() || std::fs::read_dir(library.dir()).unwrap().count() == 0,
            "{name}"
        );
    };
    refuse("empty.ttf", b"", "empty");
    refuse("notes.ttf", b"just text", "not a valid TTF/OTF");
    let mut truncated = std::fs::read(font("RedHatMono-Regular.ttf")).unwrap();
    truncated.truncate(200);
    refuse("cut.ttf", &truncated, "could not be parsed");
    let mut huge = vec![0u8; 21 * 1024 * 1024];
    huge[..4].copy_from_slice(b"\x00\x01\x00\x00");
    refuse("huge.ttf", &huge, "20 MB");
    assert_eq!(
        library
            .add(&dir.path().join("missing.ttf"))
            .unwrap_err()
            .code(),
        "not_found"
    );
}

#[test]
fn a_font_is_stored_under_a_safe_name_and_the_right_extension() {
    let (_dir, library) = library();
    let data = std::fs::read(font("RedHatMono-Regular.ttf")).unwrap();
    let odd = library.add_bytes(&data, "My Font (final) é.TXT").unwrap();
    // Anything outside letters, digits, `_` and `-` becomes `-`; an unknown
    // extension is replaced by the one the file's signature calls for.
    assert_eq!(
        (odd.id.as_str(), odd.filename.as_str()),
        ("My-Font-final", "My-Font-final.ttf")
    );
    let unnamed = library.add_bytes(&data, "").unwrap();
    assert_eq!(unnamed.id, "font");
    let symbols = library.add_bytes(&data, "???.ttf").unwrap();
    assert_eq!(symbols.id, "custom-font");
}

#[test]
fn the_nearest_face_of_a_real_family_is_chosen() {
    let (_dir, library) = library();
    library.add(&font("RedHatMono-Regular.ttf")).unwrap();
    library.add(&font("RedHatMono-Bold.ttf")).unwrap();
    let name =
        |p: Option<PathBuf>| p.map(|p| p.file_name().unwrap().to_string_lossy().into_owned());
    assert_eq!(
        name(library.resolve("Red Hat Mono", false, false, None)).as_deref(),
        Some("RedHatMono-Regular.ttf")
    );
    assert_eq!(
        name(library.resolve("red-hat-mono", true, false, None)).as_deref(),
        Some("RedHatMono-Bold.ttf")
    );
    // No italic face exists; the closest weight still answers.
    assert_eq!(
        name(library.resolve("Red Hat Mono", false, true, Some(650))).as_deref(),
        Some("RedHatMono-Bold.ttf")
    );
    assert_eq!(
        name(library.resolve("Red Hat Mono Bold", false, false, None)).as_deref(),
        Some("RedHatMono-Regular.ttf")
    );
    assert_eq!(library.resolve("Courier", false, false, None), None);
}

#[test]
fn fonts_of_an_earlier_version_are_listed_and_usable() {
    let (_dir, library) = library();
    std::fs::create_dir_all(library.dir()).unwrap();
    std::fs::copy(
        font("RedHatMono-Bold.ttf"),
        library.dir().join("old-bold.ttf"),
    )
    .unwrap();
    std::fs::write(
        library.dir().join("fonts.json"),
        r#"{"old-bold": {"family": "Red Hat Mono", "full_name": "Red Hat Mono Bold", "filename": "old-bold.ttf",
            "weight": 700, "bold": true, "italic": false}}"#,
    )
    .unwrap();
    let listed = library.list();
    assert_eq!(
        (
            listed[0].id.as_str(),
            listed[0].family.as_str(),
            listed[0].weight
        ),
        ("old-bold", "Red Hat Mono", 700)
    );
    assert!(library.resolve("Red Hat Mono", true, false, None).is_some());
    // Adding next to an old entry keeps it.
    library.add(&font("RedHatMono-Regular.ttf")).unwrap();
    assert_eq!(library.list().len(), 2);
}
