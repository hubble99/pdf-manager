//! The Edit Content host against the real worker and the pinned PDFium.
//!
//! These tests need the worker binary and the pinned library:
//! `EDIT_CONTENT_TEST_WORKER` (default: the engine's `target/debug` build) and
//! `EDIT_CONTENT_TEST_PDFIUM_PATH`. Without them a test says so and passes, so a
//! machine that has no engine still runs the rest of the suite.

use std::path::{Path, PathBuf};

use dokuwu_core::ops::edit_content::{EditContentHost, HostConfig};
use serde_json::{json, Value};

/// Tests count the worker processes of this test binary, so they run one at a time.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct Fixture {
    host: EditContentHost,
    dir: tempfile::TempDir,
    _serial: std::sync::MutexGuard<'static, ()>,
}

fn engine_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("edit-content-engine")
}

fn fixture() -> Option<Fixture> {
    let worker = std::env::var_os("EDIT_CONTENT_TEST_WORKER")
        .map(PathBuf::from)
        .unwrap_or_else(|| engine_dir().join("target").join("debug").join("edit-content-engine"));
    let library = std::env::var_os("EDIT_CONTENT_TEST_PDFIUM_PATH").map(PathBuf::from);
    let (Some(library), true) = (library, worker.is_file()) else {
        eprintln!("skipped: no Edit Content worker or pinned PDFium library");
        return None;
    };
    let serial = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let config = HostConfig {
        sessions_root: dir.path().join("sessions"),
        worker_workspace: dir.path().join("worker"),
        scratch_root: dir.path().join("scratch"),
        worker_command: vec![worker.to_string_lossy().into_owned()],
        pdfium_library: library,
        resource_root: None,
        app_version: "test".into(),
    };
    Some(Fixture { host: EditContentHost::new(config), dir, _serial: serial })
}

fn write_pdf(path: &Path, lines: &[&str]) {
    let content: String = lines
        .iter()
        .enumerate()
        .map(|(i, text)| format!("BT /F1 12 Tf 30 {} Td ({text}) Tj ET\n", 160 - 30 * i))
        .collect();
    let objects: Vec<String> = vec![
        "<< /Type /Catalog /Pages 2 0 R >>".into(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".into(),
        format!("<< /Length {} >>\nstream\n{content}endstream", content.len()),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".into(),
    ];
    let mut bytes = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(bytes.len());
        bytes.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
    }
    let xref = bytes.len();
    bytes.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for offset in offsets {
        bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    bytes.extend_from_slice(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes());
    std::fs::write(path, bytes).unwrap();
}

fn envelope(session: &str, request: &str, command: &str, revision: i64, target: Option<&str>, payload: Value) -> Value {
    let mut value = json!({
        "schemaVersion": "edit-content-request/v1", "requestId": request, "sessionId": session,
        "command": command, "expectedAcceptedRevision": revision, "payload": payload,
    });
    if let Some(target) = target {
        value["targetId"] = target.into();
    }
    value
}

struct Session<'a> {
    host: &'a EditContentHost,
    id: String,
    revision: i64,
    discovery: Value,
    counter: u32,
}

impl<'a> Session<'a> {
    fn open(host: &'a EditContentHost, pdf: &Path) -> Self {
        let reply = host.open(pdf).expect("open");
        assert_eq!(reply["status"], "accepted");
        Session {
            host,
            id: reply["sessionId"].as_str().unwrap().to_owned(),
            revision: reply["acceptedRevision"].as_i64().unwrap(),
            discovery: reply["result"]["discovery"].clone(),
            counter: 0,
        }
    }

    fn next_id(&mut self, prefix: &str) -> String {
        self.counter += 1;
        format!("{prefix}-{}", self.counter)
    }

    fn target(&self, text: &str) -> String {
        self.discovery["textObjects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|object| object["text"] == text)
            .unwrap_or_else(|| panic!("no text object {text:?} in {}", self.discovery))["targetId"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn send(&self, request: &str, command: &str, revision: i64, target: Option<&str>, payload: Value) -> Value {
        self.host.command(&self.id, envelope(&self.id, request, command, revision, target, payload)).expect("command")
    }

    fn refresh(&mut self) {
        let id = self.next_id("inspect");
        let reply = self.send(&id, "inspect", self.revision, None, json!({}));
        assert_eq!(reply["status"], "accepted", "{reply}");
        self.discovery = reply["result"]["discovery"].clone();
    }

    fn edit_payload(old: &str, new: &str) -> Value {
        json!({"edit": {
            "expectedText": old, "expectedOldText": old, "replacementText": new,
            "utf16Start": 0, "utf16End": old.encode_utf16().count(),
        }})
    }

    fn apply(&mut self, old: &str, new: &str) -> Value {
        let target = self.target(old);
        let id = self.next_id("apply");
        let reply = self.send(&id, "apply", self.revision, Some(&target), Self::edit_payload(old, new));
        if reply["status"] == "accepted" {
            self.revision = reply["acceptedRevision"].as_i64().unwrap();
            self.refresh();
        }
        reply
    }

    fn history(&mut self, action: &str) -> Value {
        let id = self.next_id(action);
        let reply = self.send(&id, "history", self.revision, None, json!({"action": action}));
        assert_eq!(reply["status"], "accepted", "{reply}");
        self.revision = reply["acceptedRevision"].as_i64().unwrap();
        self.refresh();
        reply
    }

    fn texts(&self) -> Vec<String> {
        self.discovery["textObjects"].as_array().unwrap().iter().map(|o| o["text"].as_str().unwrap().to_owned()).collect()
    }
}

fn pdf_text(path: &Path) -> String {
    use mupdf::{Document, TextPageFlags};
    let document = Document::open(path.to_str().unwrap()).unwrap();
    let mut text = String::new();
    for page in document.pages().unwrap() {
        text.push_str(&page.unwrap().to_text_page(TextPageFlags::empty()).unwrap().to_text().unwrap());
    }
    text
}

fn children_named(name: &str) -> usize {
    let me = std::process::id().to_string();
    std::fs::read_dir("/proc")
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| {
            let stat = std::fs::read_to_string(entry.path().join("stat")).unwrap_or_default();
            let comm = std::fs::read_to_string(entry.path().join("comm")).unwrap_or_default();
            // Field 4 of /proc/<pid>/stat is the parent pid.
            let parent = stat.rsplit(')').next().and_then(|rest| rest.split_whitespace().nth(1)).unwrap_or("");
            parent == me && comm.trim() == &name[..name.len().min(15)]
        })
        .count()
}

#[test]
fn edit_undo_redo_save_export_close() {
    let Some(f) = fixture() else { return };
    let pdf = f.dir.path().join("doc.pdf");
    write_pdf(&pdf, &["alpha", "beta", "gamma"]);
    let original = std::fs::read(&pdf).unwrap();
    let mut s = Session::open(&f.host, &pdf);
    assert_eq!(s.texts(), ["alpha", "beta", "gamma"]);
    assert_eq!(s.apply("alpha", "ALPHA")["status"], "accepted");
    assert_eq!(s.apply("beta", "BETA")["status"], "accepted");
    assert_eq!(s.apply("gamma", "GAMMA")["status"], "accepted");
    assert_eq!((s.revision, s.texts()), (3, vec!["ALPHA".into(), "BETA".into(), "GAMMA".into()]));
    s.history("undo");
    assert_eq!((s.revision, s.texts()), (4, vec!["ALPHA".into(), "BETA".into(), "gamma".into()]));
    s.history("redo");
    assert_eq!(s.texts(), ["ALPHA", "BETA", "GAMMA"]);

    let id = s.next_id("save");
    let saved = s.send(&id, "save", s.revision, None, json!({}));
    assert_eq!(saved["status"], "accepted", "{saved}");
    let output_id = saved["result"]["outputId"].as_str().expect("an output id");
    assert_eq!(saved["result"]["state"]["dirty"], false);

    let downloads = f.dir.path().join("Downloads");
    let first = f.host.export(&s.id, output_id, &downloads, Some("Edited")).unwrap();
    let second = f.host.export(&s.id, output_id, &downloads, Some("Edited")).unwrap();
    assert_eq!(first.file_name().unwrap(), "Edited.pdf");
    assert_eq!(second.file_name().unwrap(), "Edited (1).pdf");
    assert_eq!(std::fs::read(&first).unwrap(), std::fs::read(&second).unwrap());
    let text = pdf_text(&first);
    for word in ["ALPHA", "BETA", "GAMMA"] {
        assert!(text.contains(word), "{word} missing from {text:?}");
    }
    assert_eq!(std::fs::read(&pdf).unwrap(), original, "the opened file is never changed");
    assert!(f.host.export(&s.id, "no-such-output", &downloads, None).is_err());

    let id = s.next_id("close");
    let closed = s.send(&id, "close", s.revision, None, json!({}));
    assert_eq!(closed["status"], "accepted", "{closed}");
    assert_eq!(closed["result"]["closed"], true);
    assert_eq!(children_named("edit-content-engine"), 0, "no worker is left running");
    // A closed session is gone for later requests, but its output stays exportable.
    let late = f.host.command(&s.id, envelope(&s.id, "late", "inspect", s.revision, None, json!({})));
    assert!(late.is_err() || late.unwrap()["status"] != "accepted");
    assert!(f.host.export(&s.id, output_id, &downloads, Some("Again")).is_ok());
}

#[test]
fn a_repeated_request_returns_its_recorded_outcome_and_stale_requests_are_refused() {
    let Some(f) = fixture() else { return };
    let pdf = f.dir.path().join("doc.pdf");
    write_pdf(&pdf, &["alpha", "beta"]);
    let mut s = Session::open(&f.host, &pdf);
    let target = s.target("alpha");
    let payload = Session::edit_payload("alpha", "ALPHA");
    let first = s.send("same-request", "apply", 0, Some(&target), payload.clone());
    assert_eq!(first["status"], "accepted", "{first}");
    let again = s.send("same-request", "apply", 0, Some(&target), payload.clone());
    assert_eq!(again["status"], "duplicate");
    assert_eq!(again["result"]["originalStatus"], "accepted");
    assert_eq!(again["acceptedRevision"], 1, "the edit was applied once");
    s.revision = 1;
    s.refresh();
    let stale = s.send("stale-request", "apply", 0, Some(&s.target("beta")), Session::edit_payload("beta", "BETA"));
    assert_eq!(stale["status"], "stale", "{stale}");
    assert_eq!(stale["guardReason"], "REJECTED_STALE_REVISION");
    assert_eq!(stale["acceptedRevision"], 1);
    assert_eq!(s.texts(), ["ALPHA", "beta"]);
}

#[test]
fn a_guard_rejection_keeps_the_document_and_the_session_usable() {
    let Some(f) = fixture() else { return };
    let pdf = f.dir.path().join("doc.pdf");
    write_pdf(&pdf, &["alpha", "beta"]);
    let mut s = Session::open(&f.host, &pdf);
    // A character Helvetica (WinAnsi) cannot show.
    let rejected = s.apply("alpha", "α");
    assert_eq!(rejected["status"], "rejected", "{rejected}");
    assert!(rejected["guardReason"].as_str().unwrap().starts_with("REJECTED_"));
    assert_eq!(rejected["acceptedRevision"], 0);
    assert_eq!(s.apply("beta", "BETA")["status"], "accepted");
    assert_eq!(s.texts(), ["alpha", "BETA"]);
}

#[test]
fn preflight_is_read_only() {
    let Some(f) = fixture() else { return };
    let pdf = f.dir.path().join("doc.pdf");
    write_pdf(&pdf, &["alpha"]);
    let s = Session::open(&f.host, &pdf);
    let target = s.target("alpha");
    let mut payload = Session::edit_payload("alpha", "ALPHA");
    payload["operation"] = "preflight".into();
    let reply = s.send("pre-1", "inspect", 0, Some(&target), payload);
    assert_eq!(reply["status"], "accepted", "{reply}");
    assert_eq!(reply["result"]["preflight"]["eligible"], true);
    let state = s.host.registry().get(&s.id).unwrap().state(false).unwrap();
    assert_eq!(state.accepted_revision, 0);
    assert!(!state.can_undo);
}

#[test]
fn closing_with_unsaved_changes_needs_an_explicit_discard() {
    let Some(f) = fixture() else { return };
    let pdf = f.dir.path().join("doc.pdf");
    write_pdf(&pdf, &["alpha"]);
    let mut s = Session::open(&f.host, &pdf);
    assert_eq!(s.apply("alpha", "ALPHA")["status"], "accepted");
    let refused = s.send("close-1", "close", s.revision, None, json!({}));
    assert_eq!(refused["status"], "rejected", "{refused}");
    let stale = s.send("close-2", "close", s.revision + 5, None, json!({"decision": "discard"}));
    assert_eq!(stale["status"], "stale");
    let closed = s.send("close-3", "close", s.revision, None, json!({"decision": "discard"}));
    assert_eq!(closed["status"], "accepted", "{closed}");
}

#[test]
fn a_session_is_recovered_after_the_app_restarts() {
    let Some(f) = fixture() else { return };
    let pdf = f.dir.path().join("doc.pdf");
    write_pdf(&pdf, &["alpha", "beta"]);
    let mut s = Session::open(&f.host, &pdf);
    assert_eq!(s.apply("alpha", "ALPHA")["status"], "accepted");
    let id = s.next_id("save");
    let saved = s.send(&id, "save", s.revision, None, json!({}));
    let output_id = saved["result"]["outputId"].as_str().unwrap().to_owned();
    let session_id = s.id.clone();
    assert_eq!(f.host.shutdown().unwrap(), 1);
    assert_eq!(children_named("edit-content-engine"), 0, "shutdown stops every worker");
    drop(s);
    let host = &f.host;
    // Same host object stands in for a restarted app only partly, so build a new one on the same folders.
    let config = HostConfig {
        sessions_root: f.dir.path().join("sessions"),
        worker_workspace: f.dir.path().join("worker"),
        scratch_root: f.dir.path().join("scratch"),
        worker_command: vec![std::env::var("EDIT_CONTENT_TEST_WORKER").unwrap_or_else(|_| {
            engine_dir().join("target/debug/edit-content-engine").to_string_lossy().into_owned()
        })],
        pdfium_library: PathBuf::from(std::env::var("EDIT_CONTENT_TEST_PDFIUM_PATH").unwrap()),
        resource_root: None,
        app_version: "test".into(),
    };
    let restarted = EditContentHost::new(config);
    let _ = host;
    let reply = restarted
        .command(&session_id, envelope(&session_id, "after-restart", "inspect", 1, None, json!({})))
        .unwrap();
    assert_eq!(reply["status"], "accepted", "{reply}");
    let texts: Vec<_> = reply["result"]["discovery"]["textObjects"].as_array().unwrap().iter().map(|o| o["text"].clone()).collect();
    assert_eq!(texts, [json!("ALPHA"), json!("beta")]);
    let exported = restarted.export(&session_id, &output_id, &f.dir.path().join("out"), None).unwrap();
    assert!(pdf_text(&exported).contains("ALPHA"));
    restarted.shutdown().unwrap();
}

#[test]
fn a_worker_that_dies_is_replaced_without_losing_accepted_edits() {
    let Some(f) = fixture() else { return };
    let pdf = f.dir.path().join("doc.pdf");
    write_pdf(&pdf, &["alpha", "beta"]);
    let mut s = Session::open(&f.host, &pdf);
    assert_eq!(s.apply("alpha", "ALPHA")["status"], "accepted");
    let me = std::process::id().to_string();
    let workers: Vec<String> = std::fs::read_dir("/proc")
        .unwrap()
        .flatten()
        .filter_map(|entry| {
            let stat = std::fs::read_to_string(entry.path().join("stat")).ok()?;
            let parent = stat.rsplit(')').next()?.split_whitespace().nth(1)?.to_owned();
            let comm = std::fs::read_to_string(entry.path().join("comm")).ok()?;
            (parent == me && comm.trim() == "edit-content-en").then(|| entry.file_name().to_string_lossy().into_owned())
        })
        .collect();
    assert_eq!(workers.len(), 1, "one live session, one worker: {workers:?}");
    assert!(std::process::Command::new("kill").args(["-9", &workers[0]]).status().unwrap().success());
    std::thread::sleep(std::time::Duration::from_millis(300));
    s.refresh();
    assert_eq!(s.texts(), ["ALPHA", "beta"]);
    assert_eq!(s.apply("beta", "BETA")["status"], "accepted");
    assert_eq!(s.texts(), ["ALPHA", "BETA"]);
}

#[test]
fn a_third_document_closes_the_least_recently_used_idle_session() {
    let Some(f) = fixture() else { return };
    let pdf = f.dir.path().join("doc.pdf");
    write_pdf(&pdf, &["alpha"]);
    let first = Session::open(&f.host, &pdf);
    let second = Session::open(&f.host, &pdf);
    // Touch the first so the second is the least recently used.
    f.host.registry().get(&first.id).unwrap();
    let third = Session::open(&f.host, &pdf);
    assert_eq!(f.host.registry().live_sessions(), 2);
    let live = |id: &str| f.host.command(id, envelope(id, "probe", "inspect", 0, None, json!({}))).map(|r| r["status"].clone());
    assert_eq!(live(&first.id).unwrap(), "accepted");
    assert_eq!(live(&third.id).unwrap(), "accepted");
    f.host.shutdown().unwrap();
    let _ = second;
}

#[test]
fn invalid_requests_never_reach_a_session() {
    let Some(f) = fixture() else { return };
    let pdf = f.dir.path().join("doc.pdf");
    write_pdf(&pdf, &["alpha"]);
    let s = Session::open(&f.host, &pdf);
    let bad = |value: Value| f.host.command(&s.id, value).unwrap_err().code;
    assert_eq!(bad(envelope(&s.id, "r1", "render", 0, None, json!({"pageIndex": 0, "widthPx": 9999, "heightPx": 10}))), "INVALID_REQUEST");
    assert_eq!(bad(envelope(&"0".repeat(32), "r2", "inspect", 0, None, json!({}))), "INVALID_REQUEST");
    assert_eq!(bad(envelope(&s.id, "r3", "apply", 0, None, Session::edit_payload("alpha", "x"))), "INVALID_REQUEST");
    let unknown = f.host.command(&"f".repeat(32), envelope(&"f".repeat(32), "r4", "inspect", 0, None, json!({}))).unwrap();
    assert_eq!(unknown["status"], "rejected");
    assert_eq!(f.host.cancel(&s.id, "nothing").unwrap()["status"], "not-running");
    assert_eq!(f.host.cancel(&s.id, "bad id").unwrap_err().code, "INVALID_REQUEST");
}

#[test]
fn documents_the_engine_cannot_use_fail_with_their_reason() {
    let Some(f) = fixture() else { return };
    let dir = f.dir.path();
    let garbage = dir.join("garbage.pdf");
    std::fs::write(&garbage, b"this is not a pdf").unwrap();
    assert_eq!(f.host.open(&garbage).unwrap_err().code, "PDF_UNREADABLE");
    assert_eq!(f.host.open(&dir.join("notes.txt")).unwrap_err().code, "UNSUPPORTED_FILE");
    assert_eq!(f.host.registry().live_sessions(), 0);
    assert_eq!(children_named("edit-content-engine"), 0);
}

#[test]
#[ignore = "survey of real PDFs; run by hand"]
fn survey_fixture_pdfs() {
    let Some(f) = fixture() else { return };
    let mut files: Vec<PathBuf> = Vec::new();
    for dir in ["tests/fixtures/pdf-to-word", "tests/fixtures/pdf-compress", "../edit-content-engine/tests/fixtures", "../../frontend/public"] {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join(dir);
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            if entry.path().extension().is_some_and(|e| e == "pdf") {
                files.push(entry.path());
            }
        }
    }
    files.sort();
    for pdf in files {
        let name = pdf.file_name().unwrap().to_string_lossy().into_owned();
        match f.host.open(&pdf) {
            Err(error) => eprintln!("{name}: open refused: {}", error.code),
            Ok(reply) => {
                let mut s = Session { host: &f.host, id: reply["sessionId"].as_str().unwrap().into(), revision: 0, discovery: reply["result"]["discovery"].clone(), counter: 0 };
                let editable: Vec<String> = s.discovery["textObjects"].as_array().unwrap().iter().filter(|o| o["editable"] == true).map(|o| o["text"].as_str().unwrap().to_owned()).collect();
                let mut outcome = "no editable text".to_owned();
                if let Some(word) = editable.iter().find(|t| t.chars().count() >= 3) {
                    let replacement: String = word.chars().rev().collect();
                    let reply = s.apply(word, &replacement);
                    outcome = format!("{} {}", reply["status"], reply["guardReason"]);
                }
                eprintln!("{name}: {} text objects, {} editable, first edit {outcome}", s.discovery["textObjects"].as_array().unwrap().len(), editable.len());
                let id = s.id.clone();
                let close = envelope(&id, "survey-close", "close", s.revision, None, json!({"decision": "discard"}));
                let _ = f.host.command(&id, close);
            }
        }
    }
}
