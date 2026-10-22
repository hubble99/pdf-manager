//! Edge-case corpus for Edit Content V1, run through the real worker, the real
//! PDFium library and the real read-only resource inspector.
//!
//! Each case is a small synthetic PDF that reproduces one class of document
//! seen in UAT (longer text, missing glyphs, multi-line input, hidden text
//! layers, Type 3 fonts, signature stamps). The test pins the engine's verdict
//! for each class so a later change cannot silently loosen or tighten it.
//!
//! Run with `EDIT_CONTENT_TEST_PDFIUM_PATH=<pinned libpdfium> cargo test --locked`.

use edit_content_engine::{sha256_reader, Reply, PREPARATION_SCHEMA, REQUEST_SCHEMA};
use serde_json::{json, Value};
use std::env;
use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

const HELVETICA: &str =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

fn backend_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("backend")
}

fn test_python() -> PathBuf {
    if let Some(path) = env::var_os("EDIT_CONTENT_TEST_PYTHON") {
        return PathBuf::from(path);
    }
    let backend = backend_root();
    if cfg!(windows) {
        backend.join(".venv/Scripts/python.exe")
    } else {
        backend.join(".venv/bin/python")
    }
}

fn stream(data: &str, extra: &str) -> String {
    format!(
        "<< /Length {} {extra} >>\nstream\n{data}\nendstream",
        data.len()
    )
}

/// Writes a PDF from numbered objects (object 1 is the catalog).
fn pdf_bytes(objects: &[String]) -> Vec<u8> {
    let mut bytes = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(bytes.len());
        bytes.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
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
    bytes
}

/// One page, Helvetica as /F1, the given content stream.
fn single_page(content: &str) -> Vec<u8> {
    pdf_bytes(&[
        "<< /Type /Catalog /Pages 2 0 R >>".into(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".into(),
        stream(content, ""),
        HELVETICA.into(),
    ])
}

fn type3_page(base_font: bool) -> Vec<u8> {
    let name = if base_font {
        "/BaseFont /Type3Demo "
    } else {
        ""
    };
    pdf_bytes(&[
        "<< /Type /Catalog /Pages 2 0 R >>".into(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F3 5 0 R >> >> /Contents 4 0 R >>".into(),
        stream("BT /F3 40 Tf 40 100 Td (A) Tj ET", ""),
        format!("<< /Type /Font /Subtype /Type3 {name}/FontBBox [0 0 500 700] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /A 6 0 R /B 6 0 R >> /Encoding << /Type /Encoding /Differences [65 /A /B] >> /FirstChar 65 /LastChar 66 /Widths [500 500] /Resources << >> >>"),
        stream("500 0 0 0 500 700 d1 0 0 500 700 re f", ""),
    ])
}

/// Text painted with fill alpha 0 over a visible line, like a scanned letterhead's text layer.
fn alpha_page() -> Vec<u8> {
    pdf_bytes(&[
        "<< /Type /Catalog /Pages 2 0 R >>".into(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> /ExtGState << /G0 6 0 R >> >> /Contents 4 0 R >>".into(),
        stream("q /G0 gs BT /F1 12 Tf 30 100 Td (ghost) Tj ET Q BT /F1 12 Tf 30 60 Td (shown) Tj ET", ""),
        HELVETICA.into(),
        "<< /Type /ExtGState /ca 0 /CA 0 >>".into(),
    ])
}

/// Browser-printed page: tagged content, empty `Tj` strings, and an alpha-0 text layer
/// next to the visible text (the kind of certificate printed from a web page).
fn browser_print_page() -> Vec<u8> {
    pdf_bytes(&[
        "<< /Type /Catalog /Pages 2 0 R >>".into(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> /ExtGState << /A0 6 0 R /A1 7 0 R >> >> /Contents 4 0 R >>".into(),
        stream("/P <</MCID 0>> BDC q /A1 gs BT /F1 12 Tf 30 150 Td () Tj (ghost) Tj ET Q EMC\n/P <</MCID 1>> BDC q /A0 gs BT /F1 12 Tf 30 100 Td () Tj (shown) Tj ET Q EMC", ""),
        HELVETICA.into(),
        "<< /Type /ExtGState /ca 1 /CA 1 >>".into(),
        "<< /Type /ExtGState /ca 0 /CA 0 >>".into(),
    ])
}

/// A Tm-based letter body plus an appended BSrE-style stamp (`BT x y Td ... ET`)
/// and a signature widget whose /P points back at its page.
fn signed_page() -> Vec<u8> {
    pdf_bytes(&[
        "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] /SigFlags 3 >> >>".into(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [6 0 R] >>".into(),
        stream("BT /F1 12 Tf 1 0 0 1 30 150 Tm (Kepada Yth) Tj ET\nBT /F1 6 Tf 200 20 Td (Dokumen) Tj ET", ""),
        HELVETICA.into(),
        "<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /Rect [0 0 0 0] /F 132 /P 3 0 R >>".into(),
    ])
}

struct Worker {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    workspace_root: PathBuf,
    source: PathBuf,
    source_hash: String,
    sequence: u32,
}

impl Worker {
    fn open(pdf: &[u8]) -> Self {
        let library = env::var_os("EDIT_CONTENT_TEST_PDFIUM_PATH")
            .map(PathBuf::from)
            .expect("EDIT_CONTENT_TEST_PDFIUM_PATH must identify the pinned phase-1 library");
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let workspace_root = env::temp_dir().join(format!("edit-content-corpus-root-{unique}"));
        let source = env::temp_dir().join(format!("edit-content-corpus-source-{unique}.pdf"));
        std::fs::create_dir(&workspace_root).unwrap();
        std::fs::write(&source, pdf).unwrap();
        let script = backend_root().join("features/edit_content/resource_inspector_cli.py");
        let mut child = Command::new(env!("CARGO_BIN_EXE_edit-content-engine"))
            .args(["--pdfium-library", library.to_str().unwrap()])
            .args(["--session-id", "session-corpus"])
            .args(["--workspace-root", workspace_root.to_str().unwrap()])
            .args(["--source-file", source.to_str().unwrap()])
            .args(["--inspector-program", test_python().to_str().unwrap()])
            .args(["--inspector-arg", script.to_str().unwrap()])
            .env("PYTHONPATH", backend_root())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let source_hash = sha256_reader(&mut File::open(&source).unwrap()).unwrap();
        let mut worker = Self {
            child,
            input,
            output,
            workspace_root,
            source,
            source_hash,
            sequence: 0,
        };
        let opened = worker.call("open", None, json!({}), None);
        assert_eq!(opened.status, "accepted", "{opened:?}");
        worker
    }

    fn call(
        &mut self,
        command: &str,
        revision: Option<u64>,
        payload: Value,
        target: Option<&str>,
    ) -> Reply {
        self.sequence += 1;
        let mut value = json!({
            "schemaVersion": REQUEST_SCHEMA,
            "requestId": format!("{command}-{}", self.sequence),
            "sessionId": "session-corpus",
            "command": command,
            "payload": payload,
        });
        if let Some(revision) = revision {
            value["expectedAcceptedRevision"] = json!(revision);
        }
        if let Some(target) = target {
            value["targetId"] = json!(target);
        }
        let bytes = serde_json::to_vec(&value).unwrap();
        self.input
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .unwrap();
        self.input.write_all(&bytes).unwrap();
        self.input.flush().unwrap();
        let mut header = [0_u8; 4];
        self.output.read_exact(&mut header).unwrap();
        let mut reply = vec![0_u8; u32::from_be_bytes(header) as usize];
        self.output.read_exact(&mut reply).unwrap();
        serde_json::from_slice(&reply).unwrap()
    }

    /// Every text object the engine discovered, editable or not.
    fn objects(&mut self) -> Vec<Value> {
        let reply = self.call("inspect", Some(0), json!({}), None);
        assert_eq!(reply.status, "accepted", "{reply:?}");
        reply.result["discovery"]["textObjects"]
            .as_array()
            .unwrap()
            .clone()
    }

    fn object(&mut self, text: &str) -> Value {
        self.objects()
            .into_iter()
            .find(|object| {
                object["text"]
                    .as_str()
                    .is_some_and(|value| value.starts_with(text))
            })
            .unwrap_or_else(|| panic!("no text object {text:?}"))
    }

    fn preflight(&mut self, target: &str, edit: &Value) -> Reply {
        let mut payload = edit.as_object().unwrap().clone();
        payload.insert("operation".into(), json!("preflight"));
        self.call("inspect", Some(0), Value::Object(payload), Some(target))
    }

    fn apply(&mut self, target: &str, edit: &Value) -> Reply {
        let payload = json!({
            "acceptedCheckpointId": "source",
            "acceptedArtifactHash": self.source_hash,
            "edit": edit,
        });
        self.call("apply", Some(0), payload, Some(target))
    }

    fn close(mut self) {
        let closed = self.call("close", Some(0), json!({}), None);
        assert_eq!(closed.status, "accepted");
        drop(self.input);
        assert!(self.child.wait().unwrap().success());
        let _ = std::fs::remove_dir_all(&self.workspace_root);
        let _ = std::fs::remove_file(&self.source);
    }
}

/// The edit that replaces the leading `old` of the object text `full` with `new`.
fn replace_start(full: &str, old: &str, new: &str) -> Value {
    assert!(full.starts_with(old));
    json!({
        "expectedText": full, "expectedOldText": old, "replacementText": new,
        "utf16Start": 0, "utf16End": old.encode_utf16().count(),
    })
}

fn verdict(reply: &Reply) -> (String, Option<String>) {
    (reply.status.clone(), reply.guard_reason.clone())
}

fn detail_codes(reply: &Reply) -> Vec<String> {
    reply.result["preflight"]["detailCodes"]
        .as_array()
        .map(|codes| {
            codes
                .iter()
                .filter_map(|code| code.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// What the engine is expected to say about one edit.
struct Expect {
    /// Whether discovery offers the object as an edit target, and why not.
    editable: bool,
    view_only: Option<&'static str>,
    /// Read-only dry run (`None` = eligible).
    preflight: Option<(&'static str, &'static [&'static str])>,
    /// Full guarded transaction (`None` = a verified candidate is prepared).
    apply: Option<&'static str>,
}

const PREPARED: Expect = Expect {
    editable: true,
    view_only: None,
    preflight: None,
    apply: None,
};

struct Case {
    name: &'static str,
    pdf: Vec<u8>,
    /// The object is the first one whose text starts with this; the edit replaces it.
    old: &'static str,
    new: &'static str,
    expect: Expect,
}

/// Page 1 holds two different embedded TrueType subsets that carry the same /BaseFont name
/// (as Quartz writes them); page 2 holds Helvetica text. See tests/fixtures/make_fixtures.py.
fn two_same_name_fonts() -> Vec<u8> {
    include_bytes!("fixtures/two-same-name-fonts.pdf").to_vec()
}

fn corpus() -> Vec<Case> {
    let word = || single_page("BT /F1 12 Tf 30 100 Td (word) Tj ET");
    vec![
        Case { name: "longer text that fits without reflow", pdf: word(), old: "word", new: "wordier", expect: PREPARED },
        Case {
            name: "longer text that would run into the next object",
            pdf: single_page("BT /F1 12 Tf 30 100 Td (word) Tj ET BT /F1 12 Tf 62 100 Td (kept) Tj ET"),
            old: "word", new: "wordier",
            // Only the regenerated layout shows the overlap, so the dry run cannot see it.
            expect: Expect { apply: Some("REJECTED_LAYOUT"), ..PREPARED },
        },
        Case { name: "shorter text", pdf: word(), old: "word", new: "wo", expect: PREPARED },
        Case {
            name: "one word deleted inside an object",
            pdf: single_page("BT /F1 12 Tf 30 100 Td (two words) Tj ET"),
            old: "two ", new: "", expect: PREPARED,
        },
        Case {
            name: "whole object deleted",
            pdf: single_page("BT /F1 12 Tf 30 100 Td (gone) Tj ET BT /F1 12 Tf 30 60 Td (kept) Tj ET"),
            old: "gone", new: "", expect: PREPARED,
        },
        Case {
            name: "insertion sent as a widened one-character replacement",
            pdf: single_page("BT /F1 12 Tf 30 100 Td (ayam) Tj ET"),
            old: "a", new: "ba", expect: PREPARED,
        },
        Case {
            name: "character missing from the font",
            pdf: word(), old: "word", new: "w\u{0151}rd",
            expect: Expect {
                preflight: Some(("REJECTED_UNSUPPORTED_GLYPH", &["MISSING_GLYPH"])),
                apply: Some("REJECTED_UNSUPPORTED_GLYPH"),
                ..PREPARED
            },
        },
        Case {
            name: "multi-line replacement",
            pdf: word(), old: "word", new: "wo\nrd",
            expect: Expect {
                preflight: Some(("REJECTED_UNSUPPORTED_STRUCTURE", &["NEW_LINE"])),
                apply: Some("REJECTED_UNSUPPORTED_STRUCTURE"),
                ..PREPARED
            },
        },
        Case {
            name: "Type 3 font with a BaseFont",
            pdf: type3_page(true), old: "A", new: "B",
            expect: Expect {
                editable: false, view_only: Some("REJECTED_TYPE3"),
                preflight: Some(("REJECTED_TYPE3", &["TYPE3_FONT"])),
                apply: Some("REJECTED_TYPE3"),
            },
        },
        Case {
            // /BaseFont is optional for Type 3, so discovery cannot name the font and
            // offers the object; the dry run still refuses it before Apply.
            name: "Type 3 font without a BaseFont",
            pdf: type3_page(false), old: "A", new: "B",
            expect: Expect {
                preflight: Some(("REJECTED_UNSUPPORTED_STRUCTURE", &["UNSUPPORTED_FONT_TYPE"])),
                apply: Some("REJECTED_UNSUPPORTED_STRUCTURE"),
                ..PREPARED
            },
        },
        Case {
            name: "hidden text layer (render mode 3)",
            pdf: single_page("BT /F1 12 Tf 3 Tr 30 100 Td (hidden) Tj ET BT /F1 12 Tf 0 Tr 30 60 Td (shown) Tj ET"),
            old: "hidden", new: "hiddex",
            expect: Expect {
                editable: false, view_only: Some("INVISIBLE_TEXT"),
                preflight: Some(("REJECTED_UNSUPPORTED_STRUCTURE", &["INVISIBLE_TEXT"])),
                apply: Some("REJECTED_UNSUPPORTED_STRUCTURE"),
            },
        },
        Case {
            name: "hidden text layer (fill alpha 0)",
            pdf: alpha_page(), old: "ghost", new: "ghosx",
            expect: Expect {
                editable: false, view_only: Some("INVISIBLE_TEXT"),
                preflight: Some(("REJECTED_UNSUPPORTED_STRUCTURE", &["INVISIBLE_TEXT"])),
                apply: Some("REJECTED_UNSUPPORTED_STRUCTURE"),
            },
        },
        Case {
            // Quartz output repeats identical objects; the verifier must pair twins
            // one-to-one instead of treating them as ambiguous.
            name: "duplicate identical paths beside the edited text",
            pdf: single_page("0.8 g 20 20 100 40 re f 0.8 g 20 20 100 40 re f BT /F1 12 Tf 30 100 Td (word) Tj ET"),
            old: "word", new: "wor", expect: PREPARED,
        },
        Case {
            // Quartz stacks several rectangular clips (`W n`) on one object.
            name: "text and paths under several nested clip paths",
            pdf: single_page("q 10 10 280 180 re W n q 20 20 200 150 re W n 0.5 g 30 30 80 20 re f BT /F1 12 Tf 30 100 Td (word) Tj ET Q Q"),
            old: "word", new: "wor", expect: PREPARED,
        },
        Case {
            // Quartz paints text in ICCBased colours; edit the black word beside a green one.
            name: "text beside ICCBased-coloured text",
            pdf: include_bytes!("fixtures/icc-colored-text.pdf").to_vec(), old: "word", new: "wor", expect: PREPARED,
        },
        Case {
            // Editing text in another font must not be refused because two other fonts share a name.
            name: "text beside two embedded fonts that share a BaseFont name",
            pdf: two_same_name_fonts(), old: "gamma", new: "gamme", expect: PREPARED,
        },
        Case {
            name: "tagged page with empty Tj strings and an alpha-0 text layer",
            pdf: browser_print_page(), old: "shown", new: "shows", expect: PREPARED,
        },
        Case { name: "signed letter body next to a BSrE-style stamp", pdf: signed_page(), old: "Kepada Yth", new: "Kepada Yts", expect: PREPARED },
        Case { name: "BSrE-style stamp text (BT x y Td)", pdf: signed_page(), old: "Dokumen", new: "Dokumex", expect: PREPARED },
    ]
}

fn open_case(pdf: &[u8], old: &str) -> (Worker, Value) {
    let mut worker = Worker::open(pdf);
    let object = worker.object(old);
    (worker, object)
}

#[test]
fn edge_case_corpus_verdicts_are_pinned() {
    let mut failures = Vec::new();
    for case in corpus() {
        let (mut worker, object) = open_case(&case.pdf, case.old);
        let target = object["targetId"].as_str().unwrap().to_string();
        let edit = replace_start(object["text"].as_str().unwrap(), case.old, case.new);
        let preflight = worker.preflight(&target, &edit);
        let applied = worker.apply(&target, &edit);

        let editable = object["editable"].as_bool().unwrap();
        let view_only = object["viewOnlyReason"].as_str().map(String::from);
        if editable != case.expect.editable || view_only.as_deref() != case.expect.view_only {
            failures.push(format!(
                "{}: discovery editable={editable} viewOnly={view_only:?}",
                case.name
            ));
        }
        match case.expect.preflight {
            None if preflight.status != "accepted" => {
                failures.push(format!(
                    "{}: preflight {:?} {:?}",
                    case.name,
                    verdict(&preflight),
                    detail_codes(&preflight)
                ));
            }
            Some((reason, details)) => {
                let codes = detail_codes(&preflight);
                if preflight.status != "rejected"
                    || preflight.guard_reason.as_deref() != Some(reason)
                    || !details
                        .iter()
                        .all(|code| codes.iter().any(|seen| seen == code))
                {
                    failures.push(format!(
                        "{}: preflight {:?} {codes:?}",
                        case.name,
                        verdict(&preflight)
                    ));
                }
            }
            None => {}
        }
        assert_eq!(applied.schema_version, PREPARATION_SCHEMA, "{}", case.name);
        let expected_apply = match case.expect.apply {
            None => ("prepared".to_string(), None),
            Some(reason) => ("rejected".to_string(), Some(reason.to_string())),
        };
        if verdict(&applied) != expected_apply {
            failures.push(format!("{}: apply {:?}", case.name, verdict(&applied)));
        }
        // A rejection must leave the accepted source untouched.
        assert_eq!(
            sha256_reader(&mut File::open(&worker.source).unwrap()).unwrap(),
            worker.source_hash
        );
        worker.close();
    }
    assert!(
        failures.is_empty(),
        "edge-case verdicts changed:\n{}",
        failures.join("\n")
    );
}

/// A guard rejection discards only the candidate. The worker keeps its discovery
/// snapshot, so the same target can be corrected and applied without reselecting.
#[test]
fn a_guard_rejection_keeps_the_target_usable_for_a_corrected_draft() {
    for (pdf, old, rejected_new, reason) in [
        (
            single_page("BT /F1 12 Tf 30 100 Td (word) Tj ET"),
            "word",
            "w\u{0151}rd",
            "REJECTED_UNSUPPORTED_GLYPH",
        ),
        (
            single_page("BT /F1 12 Tf 30 100 Td (word) Tj ET BT /F1 12 Tf 62 100 Td (kept) Tj ET"),
            "word",
            "wordier",
            "REJECTED_LAYOUT",
        ),
    ] {
        let (mut worker, object) = open_case(&pdf, old);
        let target = object["targetId"].as_str().unwrap().to_string();
        let text = object["text"].as_str().unwrap().to_string();
        let rejected = worker.apply(&target, &replace_start(&text, old, rejected_new));
        assert_eq!(verdict(&rejected), ("rejected".into(), Some(reason.into())));
        let corrected = worker.apply(&target, &replace_start(&text, old, "wore"));
        assert_eq!(verdict(&corrected), ("prepared".into(), None), "{reason}");
        worker.close();
    }
}
