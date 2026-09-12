//! Raw pinned-engine characterization, not proof of a guarded transaction.
//! These fixtures contain only synthetic text and never use a user document.

use edit_content_engine::discovery::discover_document;
use edit_content_engine::identity::ObjectRegistry;
use edit_content_engine::preflight::PreflightInput;
use edit_content_engine::replacement::prepare_candidate;
use edit_content_engine::resource_inspector::{
    InspectionOutcome, ProcessResourceInspector, ResourceInspector,
};
use edit_content_engine::verification::verify;
use edit_content_engine::workspace::{CancellationToken, SessionWorkspace};
use edit_content_engine::{sha256_reader, verify_pdfium_library};
use pdfium_render::prelude::*;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn test_python() -> PathBuf {
    if let Some(path) = std::env::var_os("EDIT_CONTENT_TEST_PYTHON") {
        return PathBuf::from(path);
    }
    let backend = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("backend");
    if cfg!(windows) {
        backend.join(".venv/Scripts/python.exe")
    } else {
        backend.join(".venv/bin/python")
    }
}

fn backend_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("backend")
}

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        Self::with_stream("BT /F1 12 Tf 30 100 Td (word) Tj ET")
    }

    fn styled_rotated() -> Self {
        Self::with_stream("BT /F1 12 Tf 1 0 0 rg 0 0 1 RG 2 Tr 0 1 -1 0 150 40 Tm (word) Tj ET")
    }

    fn with_stream(text: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "edit-content-regeneration-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".to_string(),
            format!("<< /Length {} >>\nstream\n{text}\nendstream", text.len()),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_string(),
        ];
        let mut bytes = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(bytes.len());
            bytes.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", index + 1).as_bytes());
        }
        let xref = bytes.len();
        bytes.extend_from_slice(
            format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
        );
        for offset in offsets {
            bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        bytes.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        fs::write(root.join("source.pdf"), bytes).unwrap();
        Self(root)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Exact owned files only; never recursively remove a computed directory.
        for name in ["source.pdf", "working.pdf", "candidate.pdf"] {
            let _ = fs::remove_file(self.0.join(name));
        }
        let _ = fs::remove_dir(&self.0);
    }
}

fn hash(path: &Path) -> String {
    sha256_reader(&mut File::open(path).unwrap()).unwrap()
}

fn round_trip(pdfium: &Pdfium, replacement: &str, regenerate: bool) -> (String, usize) {
    let fixture = Fixture::new();
    let source = fixture.0.join("source.pdf");
    let working = fixture.0.join("working.pdf");
    let candidate = fixture.0.join("candidate.pdf");
    let original_hash = hash(&source);
    fs::copy(&source, &working).unwrap();
    {
        let document = pdfium.load_pdf_from_file(&working, None).unwrap();
        {
            let page = document.pages().get(0).unwrap();
            let mut object = page.objects().get(0).unwrap();
            let text = object.as_text_object_mut().unwrap();
            assert_eq!(text.text(), "word");
            text.set_text(replacement).unwrap();
            if regenerate {
                text.apply_matrix(PdfMatrix::IDENTITY).unwrap();
            }
        }
        document.save_to_file(&candidate).unwrap();
    }
    let result = {
        let reopened = pdfium.load_pdf_from_file(&candidate, None).unwrap();
        let page = reopened.pages().get(0).unwrap();
        let count = page.objects().len();
        let text = if count == 0 {
            String::new()
        } else {
            page.objects()
                .get(0)
                .unwrap()
                .as_text_object()
                .unwrap()
                .text()
        };
        (text, count as usize)
    };
    if replacement.is_empty() {
        let backend = backend_root();
        let inspection = std::process::Command::new(test_python())
            .args(["-c", "import json,sys; sys.path.insert(0,sys.argv.pop(1)); from pypdf import PdfReader; p=PdfReader(sys.argv[1]).pages[0]; print(json.dumps({'stream':p.get_contents().get_data().decode('ascii'), 'text':p.extract_text()}))"])
            .arg(&backend)
            .arg(&candidate)
            .output().unwrap();
        assert!(
            inspection.status.success(),
            "independent reader failed: {}",
            String::from_utf8_lossy(&inspection.stderr)
        );
        let persisted: serde_json::Value = serde_json::from_slice(&inspection.stdout).unwrap();
        assert_eq!(persisted["text"], " ");
        assert!(persisted["stream"].as_str().unwrap().contains("[<20>] TJ"));
        eprintln!("independent reader: one space; serialized text operand: <20>");
    }
    assert_eq!(hash(&source), original_hash);
    result
}

#[test]
fn pinned_regeneration_and_empty_replacement_contract() {
    // PDFium bindings initialize once per process; all probes use one instance
    // on the same execution thread, just like the feature's worker.
    let library = PathBuf::from(
        std::env::var_os("EDIT_CONTENT_TEST_PDFIUM_PATH")
            .expect("the exact pinned PDFium library is required"),
    );
    verify_pdfium_library(&library).unwrap();
    let pdfium = Pdfium::new(Pdfium::bind_to_library(&library).unwrap());
    assert_eq!(round_trip(&pdfium, "text", false), ("word".into(), 1));
    assert_eq!(round_trip(&pdfium, "text", true), ("text".into(), 1));
    // Characterizes the unresolved empty-target contract; it is NOT acceptance
    // of a space as the result of a user-requested empty replacement.
    let result = round_trip(&pdfium, "", true);
    eprintln!(
        "PDFium extracted {:?}; native object count {}",
        result.0, result.1
    );
    assert_eq!(result, (String::new(), 1));
    guarded_round_trip(&pdfium, "x", 1);
    guarded_round_trip(&pdfium, "text", 1);
    guarded_round_trip(&pdfium, "textual", 1);
    guarded_round_trip(&pdfium, "", 0);
    guarded_styled_rotated_round_trip(&pdfium);
}

fn guarded_styled_rotated_round_trip(pdfium: &Pdfium) {
    let fixture = Fixture::styled_rotated();
    guarded_fixture_round_trip(pdfium, fixture, "text", 1, true);
}

fn guarded_round_trip(pdfium: &Pdfium, replacement: &str, expected_count: usize) {
    guarded_fixture_round_trip(pdfium, Fixture::new(), replacement, expected_count, false);
}

fn guarded_fixture_round_trip(
    pdfium: &Pdfium,
    fixture: Fixture,
    replacement: &str,
    expected_count: usize,
    assert_styled_rotated: bool,
) {
    let source = fixture.0.join("source.pdf");
    let original_hash = hash(&source);
    let root = fixture.0.join("sessions");
    let workspace = SessionWorkspace::create(
        &root,
        &source,
        "guarded-test",
        &CancellationToken::default(),
    )
    .unwrap();
    let backend = backend_root();
    let inspector = ProcessResourceInspector::new(
        test_python(),
        vec![
            "-c".into(),
            "import sys; sys.path.insert(0,sys.argv.pop(1)); from features.edit_content.resource_inspector_cli import main; raise SystemExit(main())".into(),
            backend.display().to_string(),
        ],
    );
    let InspectionOutcome::Supported(inspection) = inspector.inspect(workspace.source_path())
    else {
        panic!("real resource inspection required");
    };
    let mut registry = ObjectRegistry::new("guarded-test");
    let target = {
        let document = pdfium
            .load_pdf_from_file(workspace.source_path(), None)
            .unwrap();
        let discovery = discover_document(&document, &inspection, &mut registry, 0).unwrap();
        discovery.text_objects[0].target_id.clone()
    };
    let input = PreflightInput {
        expected_text: "word".into(),
        expected_old_text: "word".into(),
        replacement_text: replacement.into(),
        utf16_start: 0,
        utf16_end: 4,
    };
    let candidate = prepare_candidate(
        pdfium, &workspace, &registry, 0, &target, &input, &inspector,
    )
    .unwrap();
    assert_eq!(candidate.baseline_sha256, original_hash);
    assert_eq!(candidate.expectation.removed, replacement.is_empty());
    {
        let reopened = pdfium.load_pdf_from_file(&candidate.path, None).unwrap();
        let page = reopened.pages().get(0).unwrap();
        assert_eq!(page.objects().len() as usize, expected_count);
        if expected_count != 0 {
            let object = page.objects().get(0).unwrap();
            let text = object.as_text_object().unwrap();
            assert_eq!(text.text(), replacement);
            if assert_styled_rotated {
                assert!(text.get_rotation_counter_clockwise_degrees().abs() > 89.0);
                let fill = text.fill_color().unwrap();
                assert_eq!(
                    (fill.red(), fill.green(), fill.blue(), fill.alpha()),
                    (255, 0, 0, 255)
                );
                let stroke = text.stroke_color().unwrap();
                assert_eq!(
                    (stroke.red(), stroke.green(), stroke.blue(), stroke.alpha()),
                    (0, 0, 255, 255)
                );
                assert_eq!(format!("{:?}", text.render_mode()), "FilledThenStroked");
            }
        }
    }
    let independent = std::process::Command::new(test_python())
        .args(["-c", "import json,sys; sys.path.insert(0,sys.argv.pop(1)); from pypdf import PdfReader; print(json.dumps(PdfReader(sys.argv[1]).pages[0].extract_text()))"])
        .arg(&backend)
        .arg(&candidate.path).output().unwrap();
    assert!(
        independent.status.success(),
        "{}",
        String::from_utf8_lossy(&independent.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<String>(&independent.stdout).unwrap(),
        replacement
    );
    assert_eq!(hash(&source), original_hash);
    assert_eq!(hash(workspace.source_path()), original_hash);
    let mut stale = input.clone();
    stale.expected_text = "not the target".into();
    assert!(
        prepare_candidate(pdfium, &workspace, &registry, 0, &target, &stale, &inspector).is_err()
    );
    assert!(
        prepare_candidate(pdfium, &workspace, &registry, 1, &target, &input, &inspector).is_err()
    );
    let verified = verify(pdfium, candidate, &inspector).unwrap();
    assert_eq!(verified.report().object_census, vec![expected_count]);
    verified.recheck().unwrap();
    workspace.cleanup().unwrap();
    fs::remove_dir(root).unwrap();
}
