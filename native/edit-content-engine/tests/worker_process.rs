use edit_content_engine::viewport::{PageRotation, Point, Rect, ViewportTransform};
use edit_content_engine::{sha256_reader, Reply, MAX_REQUEST_BYTES, REQUEST_SCHEMA};
use serde_json::{json, Value};
use std::env;
use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Output, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

struct Worker {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    workspace_root: PathBuf,
    source: PathBuf,
}

impl Worker {
    fn start(extra: &[&str]) -> Self {
        Self::start_with_writer(extra, write_minimal_pdf)
    }

    fn start_phase3(extra: &[&str]) -> Self {
        Self::start_with_writer(extra, write_phase3_pdf)
    }

    fn start_with_writer(extra: &[&str], writer: fn(&Path)) -> Self {
        let library = pinned_library();
        let (workspace_root, source) = worker_files(writer);
        let mut child = Command::new(env!("CARGO_BIN_EXE_edit-content-engine"))
            .args([
                "--pdfium-library",
                library.to_str().unwrap(),
                "--session-id",
                "session-test",
                "--workspace-root",
                workspace_root.to_str().unwrap(),
                "--source-file",
                source.to_str().unwrap(),
            ])
            .args(extra)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            input,
            output,
            workspace_root,
            source,
        }
    }

    fn send(&mut self, value: Value) {
        let bytes = serde_json::to_vec(&value).unwrap();
        self.input
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .unwrap();
        self.input.write_all(&bytes).unwrap();
        self.input.flush().unwrap();
    }

    fn reply(&mut self) -> Reply {
        let mut header = [0_u8; 4];
        self.output.read_exact(&mut header).unwrap();
        let mut bytes = vec![0_u8; u32::from_be_bytes(header) as usize];
        self.output.read_exact(&mut bytes).unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn close(mut self, request_id: &str) {
        self.send(request(request_id, "close", Some(0), json!({})));
        assert_eq!(self.reply().status, "accepted");
        drop(self.input);
        assert!(self.child.wait().unwrap().success());
        assert_eq!(std::fs::read_dir(&self.workspace_root).unwrap().count(), 0);
        std::fs::remove_dir(&self.workspace_root).unwrap();
        std::fs::remove_file(&self.source).unwrap();
    }
}

fn pinned_library() -> PathBuf {
    env::var_os("EDIT_CONTENT_TEST_PDFIUM_PATH")
        .map(PathBuf::from)
        .expect("EDIT_CONTENT_TEST_PDFIUM_PATH must identify the pinned phase-1 library")
}

fn worker_files(writer: fn(&Path)) -> (PathBuf, PathBuf) {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let workspace_root = env::temp_dir().join(format!("edit-content-worker-root-{unique}"));
    let source = env::temp_dir().join(format!("edit-content-worker-source-{unique}.pdf"));
    std::fs::create_dir(&workspace_root).unwrap();
    writer(&source);
    (workspace_root, source)
}

fn write_minimal_pdf(path: &Path) {
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>",
        "<< /Length 0 >>\nstream\n\nendstream",
    ];
    write_pdf_objects(
        path,
        &objects.iter().map(ToString::to_string).collect::<Vec<_>>(),
    );
}

fn write_phase3_pdf(path: &Path) {
    fn stream(data: &str, extra: &str) -> String {
        format!(
            "<< /Length {} {} >>\nstream\n{}\nendstream",
            data.len(),
            extra,
            data
        )
    }
    let objects = vec![
        "<< /Type /Catalog /Pages 2 0 R >>".into(),
        "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R 7 0 R] /Count 5 >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 200] /CropBox [10 20 230 190] /Resources << /Font << /F1 8 0 R >> >> /Contents [9 0 R 18 0 R] >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 200] /Rotate 90 /Resources << /Font << /F1 8 0 R >> >> /Contents 10 0 R >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 200] /Resources << /Font << /F3 11 0 R >> >> /Contents 12 0 R >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 200] /Resources << /XObject << /Fm 14 0 R >> >> /Contents 13 0 R >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 200] /Resources << /XObject << /Im 16 0 R >> >> /Contents 15 0 R >>".into(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".into(),
        stream("BT /F1 18 Tf 30 140 Td (Office-like duplicate) Tj ET", ""),
        stream("BT /F1 16 Tf 0 1 -1 0 150 40 Tm (Rotated text) Tj ET", ""),
        "<< /Type /Font /Subtype /Type3 /BaseFont /Type3Demo /FontBBox [0 0 500 700] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /A 17 0 R >> /Encoding << /Type /Encoding /Differences [65 /A] >> /FirstChar 65 /LastChar 65 /Widths [500] /Resources << >> >>".into(),
        stream("BT /F3 40 Tf 40 100 Td (A) Tj ET", ""),
        stream("q /Fm Do Q", ""),
        stream("BT /F1 14 Tf 20 80 Td (Nested form text) Tj ET", "/Type /XObject /Subtype /Form /BBox [0 0 200 100] /Resources << /Font << /F1 8 0 R >> >>"),
        stream("q 80 0 0 80 20 100 cm /Im Do Q\n0 0 1 rg 20 20 100 40 re f", ""),
        stream("ff0000>", "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode"),
        stream("0 0 500 700 re f", ""),
        stream("BT /F1 18 Tf 30 140 Td (Office-like duplicate) Tj ET", ""),
    ];
    write_pdf_objects(path, &objects);
}

fn write_pdf_objects(path: &Path, objects: &[String]) {
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
    std::fs::write(path, bytes).unwrap();
}

fn request(id: &str, command: &str, revision: Option<u64>, payload: Value) -> Value {
    let mut value = json!({
        "schemaVersion": REQUEST_SCHEMA,
        "requestId": id,
        "sessionId": "session-test",
        "command": command,
        "payload": payload,
    });
    if let Some(revision) = revision {
        value["expectedAcceptedRevision"] = json!(revision);
    }
    value
}

fn decode_base64(value: &str) -> Vec<u8> {
    fn digit(value: u8) -> Option<u8> {
        match value {
            b'A'..=b'Z' => Some(value - b'A'),
            b'a'..=b'z' => Some(value - b'a' + 26),
            b'0'..=b'9' => Some(value - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut decoded = Vec::new();
    for chunk in value.as_bytes().chunks_exact(4) {
        let a = digit(chunk[0]).unwrap();
        let b = digit(chunk[1]).unwrap();
        let c = digit(chunk[2]).unwrap_or(0);
        let d = digit(chunk[3]).unwrap_or(0);
        decoded.push((a << 2) | (b >> 4));
        if chunk[2] != b'=' {
            decoded.push((b << 4) | (c >> 2));
        }
        if chunk[3] != b'=' {
            decoded.push((c << 6) | d);
        }
    }
    decoded
}

fn contains_prohibited_reply_key(value: &Value) -> bool {
    const PROHIBITED: [&str; 6] = [
        "nativeHandle",
        "nativeObjectPointer",
        "filesystemPath",
        "sourcePath",
        "candidatePath",
        "fontProgramBytes",
    ];
    match value {
        Value::Object(map) => map.iter().any(|(key, child)| {
            PROHIBITED.contains(&key.as_str()) || contains_prohibited_reply_key(child)
        }),
        Value::Array(values) => values.iter().any(contains_prohibited_reply_key),
        _ => false,
    }
}

fn rejected_start(path: &Path) -> Output {
    let (workspace_root, source) = worker_files(write_minimal_pdf);
    let output = Command::new(env!("CARGO_BIN_EXE_edit-content-engine"))
        .args([
            "--pdfium-library",
            path.to_str().unwrap(),
            "--session-id",
            "session-test",
            "--workspace-root",
            workspace_root.to_str().unwrap(),
            "--source-file",
            source.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    std::fs::remove_dir(workspace_root).unwrap();
    std::fs::remove_file(source).unwrap();
    output
}

#[test]
fn matching_binary_starts_and_missing_or_wrong_binary_is_rejected() {
    let mut worker = Worker::start(&[]);
    worker.send(request("open-1", "open", None, json!({})));
    let reply = worker.reply();
    assert_eq!(reply.status, "accepted", "{reply:?}");
    assert_eq!(reply.result["engine"]["wrapper"], "0.9.4");
    assert_eq!(reply.result["engine"]["buildIdentity"], "154.0.8035");
    worker.close("close-1");

    let missing = rejected_start(Path::new("definitely-missing-pdfium-library"));
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("missing or unreadable"));

    let wrong = rejected_start(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("Cargo.toml")
            .as_path(),
    );
    assert!(!wrong.status.success());
    assert!(String::from_utf8_lossy(&wrong.stderr).contains("hash does not match"));
}

#[test]
fn malformed_and_oversized_frames_are_bounded() {
    let mut malformed = Worker::start(&[]);
    malformed.input.write_all(&3_u32.to_be_bytes()).unwrap();
    malformed.input.write_all(b"bad").unwrap();
    malformed.input.flush().unwrap();
    let reply = malformed.reply();
    assert_eq!(reply.status, "unknown");
    assert!(reply.error.unwrap().contains("not valid protocol JSON"));
    malformed.close("close-malformed");

    let mut oversized = Worker::start(&[]);
    oversized
        .input
        .write_all(&((MAX_REQUEST_BYTES + 1) as u32).to_be_bytes())
        .unwrap();
    oversized.input.flush().unwrap();
    let reply = oversized.reply();
    assert_eq!(reply.status, "unknown");
    assert!(reply.error.unwrap().contains("exceeds configured limit"));
    drop(oversized.input);
    assert!(oversized.child.wait().unwrap().success());
}

#[test]
fn duplicate_ids_and_stale_revisions_never_execute_native_work() {
    let mut worker = Worker::start(&["--test-mode"]);
    worker.send(request("open-duplicate", "open", None, json!({})));
    let original = worker.reply();
    assert_eq!(original.status, "accepted");
    assert_eq!(original.result["executionSequence"], 1);

    worker.send(request(
        "open-duplicate",
        "open",
        None,
        json!({"different": true}),
    ));
    let duplicate = worker.reply();
    assert_eq!(duplicate.status, "duplicate");
    assert_eq!(duplicate.result["mutationReplayed"], false);

    worker.send(request("stale-1", "inspect", Some(1), json!({})));
    let stale = worker.reply();
    assert_eq!(stale.status, "stale");
    assert_eq!(stale.accepted_revision, 0);
    assert_eq!(
        stale.guard_reason.as_deref(),
        Some("REJECTED_STALE_REVISION")
    );

    worker.send(request("inspect-current", "inspect", Some(0), json!({})));
    let current = worker.reply();
    assert_eq!(current.status, "accepted");
    assert_eq!(current.result["executionSequence"], 2);
    worker.close("close-duplicate");
}

#[test]
fn serial_queue_applies_backpressure() {
    let mut worker = Worker::start(&["--test-mode", "--test-timeout-ms", "1000"]);
    worker.send(request("open-queue", "open", None, json!({})));
    assert_eq!(worker.reply().status, "accepted");
    worker.send(request(
        "slow",
        "inspect",
        Some(0),
        json!({"testDelayMs": 200}),
    ));
    // Let the dispatcher hand the slow request to the native thread before filling
    // the bounded input queue; otherwise scheduler timing can make two requests
    // race for the same single transition slot.
    std::thread::sleep(Duration::from_millis(20));
    worker.send(request("queued-1", "inspect", Some(0), json!({})));
    worker.send(request("queued-2", "inspect", Some(0), json!({})));
    worker.send(request("overflow", "inspect", Some(0), json!({})));

    let replies = [
        worker.reply(),
        worker.reply(),
        worker.reply(),
        worker.reply(),
    ];
    assert_eq!(
        replies
            .iter()
            .filter(|reply| {
                reply.status == "unknown"
                    && reply.error.as_deref() == Some("worker queue capacity exceeded")
            })
            .count(),
        1
    );
    let sequences: Vec<u64> = replies
        .iter()
        .filter_map(|reply| reply.result["executionSequence"].as_u64())
        .collect();
    assert_eq!(sequences, vec![2, 3, 4]);
    worker.close("close-queue");
}

#[test]
fn timeout_and_crash_are_confined_to_the_worker_process() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let sentinel = env::temp_dir().join(format!("edit-content-canvas-sentinel-{unique}"));
    std::fs::write(&sentinel, b"canvas-untouched").unwrap();

    let mut timeout = Worker::start(&["--test-mode", "--test-timeout-ms", "25"]);
    timeout.send(request(
        "timeout",
        "inspect",
        Some(0),
        json!({"testDelayMs": 100}),
    ));
    let reply = timeout.reply();
    assert_eq!(reply.status, "unknown");
    assert!(reply.error.unwrap().contains("timed out"));
    drop(timeout.input);
    assert!(!timeout.child.wait().unwrap().success());
    std::fs::remove_dir_all(timeout.workspace_root).unwrap();
    std::fs::remove_file(timeout.source).unwrap();

    let mut crash = Worker::start(&["--test-mode"]);
    crash.send(request(
        "crash",
        "inspect",
        Some(0),
        json!({"testCrash": true}),
    ));
    let reply = crash.reply();
    assert_eq!(reply.status, "unknown");
    assert!(reply.error.unwrap().contains("worker exited"));
    drop(crash.input);
    assert!(!crash.child.wait().unwrap().success());
    std::fs::remove_dir_all(crash.workspace_root).unwrap();
    std::fs::remove_file(crash.source).unwrap();

    assert_eq!(std::fs::read(&sentinel).unwrap(), b"canvas-untouched");
    std::fs::remove_file(sentinel).unwrap();

    let worker = Worker::start(&[]);
    worker.close("close-after-crash");
}

#[test]
fn production_inspection_fails_closed_without_the_companion_parser() {
    let mut worker = Worker::start(&[]);
    worker.send(request("open-no-inspector", "open", None, json!({})));
    assert_eq!(worker.reply().status, "accepted");
    worker.send(request(
        "inspect-no-inspector",
        "inspect",
        Some(0),
        json!({}),
    ));
    let reply = worker.reply();
    assert_eq!(reply.status, "rejected");
    assert_eq!(
        reply.guard_reason.as_deref(),
        Some("REJECTED_UNSUPPORTED_STRUCTURE")
    );
    worker.close("close-no-inspector");
}

#[cfg(target_os = "linux")]
#[test]
fn worker_open_inspect_close_uses_the_pinned_read_only_companion() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let backend = manifest.parent().unwrap().parent().unwrap().join("backend");
    let site_packages = backend.join(".venv/Lib/site-packages");
    let python_path = format!(
        "PYTHONPATH={}:{}",
        backend.display(),
        site_packages.display()
    );
    let script = backend.join("features/edit_content/resource_inspector_cli.py");
    let arguments = [
        "--inspector-program",
        "/usr/bin/env",
        "--inspector-arg",
        python_path.as_str(),
        "--inspector-arg",
        "python3",
        "--inspector-arg",
        script.to_str().unwrap(),
    ];
    let mut worker = Worker::start_phase3(&arguments);
    let source_sha256 = sha256_reader(&mut File::open(&worker.source).unwrap()).unwrap();
    worker.send(request("open-real-inspector", "open", None, json!({})));
    let open_reply = worker.reply();
    assert_eq!(open_reply.status, "accepted");
    assert_eq!(open_reply.result["sourceSha256"], source_sha256);
    worker.send(request(
        "inspect-real-inspector",
        "inspect",
        Some(0),
        json!({}),
    ));
    let reply = worker.reply();
    assert_eq!(reply.status, "accepted", "{reply:?}");
    assert_eq!(reply.result["inspection"]["supported"], true);
    assert_eq!(
        reply.result["inspection"]["schemaVersion"],
        "edit-content-resource-inspection/v1"
    );
    let discovery = &reply.result["discovery"];
    assert_eq!(discovery["schemaVersion"], "edit-content-inspection/v1");
    assert_eq!(discovery["readOnly"], true);
    let text_objects = discovery["textObjects"].as_array().unwrap();
    assert!(text_objects.iter().any(|object| {
        object["text"] == "Office-like duplicate"
            && object["font"]["name"]
                .as_str()
                .is_some_and(|name| name.contains("Helvetica"))
            && object["bounds"].is_object()
            && object["rotatedQuad"]["points"]
                .as_array()
                .is_some_and(|points| points.len() == 4)
            && object["matrix"].is_object()
            && object["renderMode"].is_string()
    }));
    assert!(!text_objects.iter().any(|object| object["pageIndex"] == 3));
    assert!(!text_objects.iter().any(|object| object["pageIndex"] == 4));
    let type3 = text_objects
        .iter()
        .find(|object| object["text"] == "A")
        .unwrap();
    let type3_point = json!({
        "x": (type3["bounds"]["left"].as_f64().unwrap() + type3["bounds"]["right"].as_f64().unwrap()) / 2.0,
        "y": (type3["bounds"]["bottom"].as_f64().unwrap() + type3["bounds"]["top"].as_f64().unwrap()) / 2.0,
    });
    worker.send(request(
        "hit-type3",
        "inspect",
        Some(0),
        json!({"operation": "hitTest", "pageIndex": 2, "point": type3_point}),
    ));
    let type3_hit = worker.reply();
    assert_eq!(type3_hit.result["hitTest"]["outcome"], "viewOnly");
    assert_eq!(type3_hit.result["hitTest"]["reason"], "REJECTED_TYPE3");
    assert_eq!(type3_hit.result["hitTest"]["mutationCommandCreated"], false);
    assert!(text_objects.iter().any(|object| {
        object["text"] == "Rotated text"
            && object["rotation"]
                .as_f64()
                .is_some_and(|rotation| rotation.abs() > 89.0)
    }));
    let rotated_target = text_objects
        .iter()
        .find(|object| object["text"] == "Rotated text")
        .unwrap()["targetId"]
        .as_str()
        .unwrap()
        .to_owned();
    let type3_target = type3["targetId"].as_str().unwrap().to_owned();
    assert!(text_objects.iter().any(|object| {
        object["text"] == "A"
            && object["editable"] == false
            && object["viewOnlyReason"] == "REJECTED_TYPE3"
            && object["font"]["resourceSubtype"] == "/Type3"
    }));
    let view_only = discovery["viewOnlyObjects"].as_array().unwrap();
    for native_type in ["form", "image", "path"] {
        assert!(view_only.iter().any(|object| {
            object["nativeType"] == native_type
                && object["rendered"] == true
                && object["fabricatedTextObject"] == false
        }));
    }

    let office = text_objects
        .iter()
        .find(|object| object["text"] == "Office-like duplicate")
        .unwrap();
    let point = json!({
        "x": (office["bounds"]["left"].as_f64().unwrap() + office["bounds"]["right"].as_f64().unwrap()) / 2.0,
        "y": (office["bounds"]["bottom"].as_f64().unwrap() + office["bounds"]["top"].as_f64().unwrap()) / 2.0,
    });
    let pdf_point = Point {
        x: point["x"].as_f64().unwrap() as f32,
        y: point["y"].as_f64().unwrap() as f32,
    };
    let viewport_transform = ViewportTransform {
        crop_box: Rect {
            left: 10.0,
            bottom: 20.0,
            right: 230.0,
            top: 190.0,
        },
        rotation: PageRotation::None,
        zoom: 1.0,
        device_pixel_ratio: 2.0,
        scroll_css: Point { x: 3.0, y: 4.0 },
        viewport_origin_css: Point { x: 7.0, y: 8.0 },
        viewport_size_css: Point { x: 440.0, y: 340.0 },
    };
    let viewport_point = viewport_transform.pdf_to_viewport_css(pdf_point).unwrap();
    worker.send(request(
        "hit-overlap",
        "inspect",
        Some(0),
        json!({
            "operation": "hitTest",
            "pageIndex": 0,
            "coordinateSpace": "viewportCss",
            "point": viewport_point,
            "viewportTransform": viewport_transform,
        }),
    ));
    let hit = worker.reply();
    assert_eq!(hit.status, "accepted");
    assert_eq!(hit.result["hitTest"]["outcome"], "ambiguous");
    assert_eq!(hit.result["hitTest"]["mutationCommandCreated"], false);

    let old_target = office["targetId"].as_str().unwrap().to_owned();
    let mut range = request(
        "validate-range",
        "inspect",
        Some(0),
        json!({
            "operation": "validateTextRange",
            "utf16Start": 0,
            "utf16End": 6,
            "expectedText": "Office-like duplicate"
        }),
    );
    range["targetId"] = json!(old_target.clone());
    worker.send(range);
    let range_reply = worker.reply();
    assert_eq!(range_reply.status, "accepted");
    assert_eq!(
        range_reply.result["unicodeRange"]["schemaVersion"],
        "edit-content-unicode-range/v1"
    );
    assert_eq!(range_reply.result["unicodeRange"]["unit"], "unicode-scalar");
    assert_eq!(range_reply.result["unicodeRange"]["scalarStart"], 0);
    assert_eq!(range_reply.result["unicodeRange"]["scalarEnd"], 6);
    assert_eq!(range_reply.result["exactObjectTextMatched"], true);
    assert_eq!(range_reply.result["mutationCommandCreated"], false);

    let mut legacy = request(
        "reject-legacy-range",
        "inspect",
        Some(0),
        json!({
            "operation": "validateTextRange",
            "utf16Start": 0,
            "utf16End": 1,
            "expectedText": "Office-like duplicate"
        }),
    );
    legacy["targetId"] = json!("page-0-object-0");
    worker.send(legacy);
    let legacy_reply = worker.reply();
    assert_eq!(legacy_reply.status, "stale");
    assert_eq!(
        legacy_reply.guard_reason.as_deref(),
        Some("REJECTED_STALE_TARGET")
    );

    let mut eligible_preflight = request(
        "preflight-eligible",
        "inspect",
        Some(0),
        json!({
            "operation": "preflight",
            "expectedText": "Rotated text",
            "expectedOldText": "Rotated",
            "replacementText": "Updated",
            "utf16Start": 0,
            "utf16End": 7
        }),
    );
    eligible_preflight["targetId"] = json!(rotated_target.clone());
    worker.send(eligible_preflight);
    let eligible = worker.reply();
    assert_eq!(eligible.status, "accepted");
    assert_eq!(eligible.result["preflight"]["eligible"], true);
    assert_eq!(
        eligible.result["preflight"]["resultingText"],
        "Updated text"
    );
    assert_eq!(
        eligible.result["preflight"]["mutationNeutral"]["originalSha256"],
        source_sha256
    );
    assert_eq!(
        eligible.result["preflight"]["mutationNeutral"]["acceptedSha256"],
        source_sha256
    );
    assert_eq!(
        eligible.result["preflight"]["mutationNeutral"]["acceptedRevision"],
        0
    );
    assert_eq!(
        eligible.result["preflight"]["mutationNeutral"]["acceptedHistoryLength"],
        0
    );
    assert_eq!(
        eligible.result["preflight"]["mutationNeutral"]["publishedArtifactCreated"],
        false
    );
    assert_eq!(
        eligible.result["preflight"]["mutationNeutral"]["mutationAttempted"],
        false
    );
    assert_eq!(
        eligible.result["preflight"]["mutationNeutral"]["mutationCommandCreated"],
        false
    );
    assert!(!contains_prohibited_reply_key(
        &serde_json::to_value(&eligible).unwrap()
    ));

    let mut missing_glyph = request(
        "preflight-missing-glyph",
        "inspect",
        Some(0),
        json!({
            "operation": "preflight",
            "expectedText": "Rotated text",
            "expectedOldText": "Rotated",
            "replacementText": "Rőtated",
            "utf16Start": 0,
            "utf16End": 7
        }),
    );
    missing_glyph["targetId"] = json!(rotated_target.clone());
    worker.send(missing_glyph);
    let missing = worker.reply();
    assert_eq!(missing.status, "rejected");
    assert_eq!(
        missing.guard_reason.as_deref(),
        Some("REJECTED_UNSUPPORTED_GLYPH")
    );
    assert_eq!(missing.accepted_revision, 0);
    assert_eq!(
        missing.result["preflight"]["unsupportedCodePoints"],
        json!(['ő' as u32])
    );
    assert_eq!(
        missing.result["preflight"]["mutationNeutral"]["acceptedSha256"],
        source_sha256
    );
    assert!(!contains_prohibited_reply_key(
        &serde_json::to_value(&missing).unwrap()
    ));

    let mut type3_preflight = request(
        "preflight-type3",
        "inspect",
        Some(0),
        json!({
            "operation": "preflight",
            "expectedText": "A",
            "expectedOldText": "A",
            "replacementText": "B",
            "utf16Start": 0,
            "utf16End": 1
        }),
    );
    type3_preflight["targetId"] = json!(type3_target);
    worker.send(type3_preflight);
    let rejected_type3 = worker.reply();
    assert_eq!(rejected_type3.status, "rejected");
    assert_eq!(
        rejected_type3.guard_reason.as_deref(),
        Some("REJECTED_TYPE3")
    );
    assert!(!contains_prohibited_reply_key(
        &serde_json::to_value(&rejected_type3).unwrap()
    ));

    let mut malformed_preflight = request(
        "preflight-malformed",
        "inspect",
        Some(0),
        json!({"operation": "preflight", "expectedText": "Rotated text"}),
    );
    malformed_preflight["targetId"] = json!(rotated_target.clone());
    worker.send(malformed_preflight);
    let malformed = worker.reply();
    assert_eq!(malformed.status, "rejected");
    assert_eq!(
        malformed.guard_reason.as_deref(),
        Some("REJECTED_UNSUPPORTED_STRUCTURE")
    );
    assert_eq!(
        malformed.result["preflight"]["mutationNeutral"]["originalSha256"],
        source_sha256
    );
    assert_eq!(
        malformed.result["preflight"]["mutationNeutral"]["acceptedSha256"],
        source_sha256
    );
    assert!(!contains_prohibited_reply_key(
        &serde_json::to_value(&malformed).unwrap()
    ));

    let mut unavailable_apply = request("phase-five-not-exposed", "apply", Some(0), json!({}));
    unavailable_apply["targetId"] = json!(rotated_target);
    worker.send(unavailable_apply);
    let apply_reply = worker.reply();
    assert_eq!(apply_reply.status, "rejected");
    assert_eq!(
        apply_reply.guard_reason.as_deref(),
        Some("REJECTED_UNSUPPORTED_STRUCTURE")
    );
    assert_eq!(
        sha256_reader(&mut File::open(&worker.source).unwrap()).unwrap(),
        source_sha256
    );

    worker.send(request("refresh-discovery", "inspect", Some(0), json!({})));
    assert_eq!(worker.reply().status, "accepted");
    let mut stale_hit = request(
        "stale-hit",
        "inspect",
        Some(0),
        json!({"operation": "hitTest", "pageIndex": 0, "point": point}),
    );
    stale_hit["targetId"] = json!(old_target);
    worker.send(stale_hit);
    let stale = worker.reply();
    assert_eq!(stale.result["hitTest"]["outcome"], "stale");
    assert_eq!(stale.result["hitTest"]["mutationCommandCreated"], false);

    worker.send(request(
        "render-view-only",
        "render",
        Some(0),
        json!({"pageIndex": 4, "widthPx": 240, "heightPx": 200}),
    ));
    let render = worker.reply();
    assert_eq!(render.status, "accepted");
    assert_eq!(render.result["mimeType"], "image/jpeg");
    let rendered_bytes = decode_base64(render.result["dataBase64"].as_str().unwrap());
    assert!(rendered_bytes.len() > 100);
    let rendered_image = image::load_from_memory(&rendered_bytes).unwrap().to_rgb8();
    assert!(rendered_image
        .pixels()
        .any(|pixel| pixel.0 != [255, 255, 255]));
    assert_eq!(render.result["sha256"].as_str().unwrap().len(), 64);
    assert_eq!(render.result["mutationCommandCreated"], false);
    let first_render_hash = render.result["sha256"].as_str().unwrap().to_owned();
    worker.send(request(
        "render-view-only-repeat",
        "render",
        Some(0),
        json!({"pageIndex": 4, "widthPx": 240, "heightPx": 200}),
    ));
    let repeated_render = worker.reply();
    assert_eq!(repeated_render.status, "accepted");
    assert_eq!(repeated_render.result["sha256"], first_render_hash);
    worker.close("close-real-inspector");
}
