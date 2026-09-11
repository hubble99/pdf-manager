use edit_content_engine::discovery::discover_document;
use edit_content_engine::hit_test::hit_test;
use edit_content_engine::identity::{utf16_range_to_scalar, ObjectRegistry, ResolveError};
use edit_content_engine::preflight::{
    evaluate_preflight, rejected_preflight_report, PreflightInput,
};
use edit_content_engine::resource_inspector::{
    InspectionOutcome, ProcessResourceInspector, ResourceInspector, TestResourceInspector,
    UnavailableResourceInspector,
};
use edit_content_engine::viewport::{Point, ViewportTransform};
use edit_content_engine::workspace::{CancellationToken, SessionWorkspace};
use edit_content_engine::{
    bounded_request_channel, duplicate_reply, read_frame, send_backpressure, send_reply,
    sha256_reader, timeout_for, validate_request, verify_pdfium_library, FrameRead, Reply, Request,
    RequestLedger, SharedWriter, MAX_REPLY_BYTES, PDFIUM_BUILD_IDENTITY, PDFIUM_LIBRARY_SHA256,
    PDFIUM_RENDER_VERSION, STARTUP_TIMEOUT,
};
use image::codecs::jpeg::JpegEncoder;
use pdfium_render::prelude::{PdfDocument, Pdfium, PdfiumLibraryBindings};
use serde_json::{json, Value};
use std::env;
use std::io::{self, BufReader, BufWriter, Cursor};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

struct Config {
    pdfium_library: PathBuf,
    session_id: String,
    workspace_root: PathBuf,
    source_file: PathBuf,
    inspector_program: Option<PathBuf>,
    inspector_arguments: Vec<String>,
    test_mode: bool,
    test_timeout: Option<Duration>,
}

struct NativeJob {
    request: Request,
    revision: u64,
    reply: mpsc::SyncSender<NativeOutcome>,
}

struct NativeOutcome {
    reply: Reply,
    shutdown: bool,
}

fn parse_config() -> Result<Config, String> {
    let mut pdfium_library = None;
    let mut session_id = None;
    let mut workspace_root = None;
    let mut source_file = None;
    let mut inspector_program = None;
    let mut inspector_arguments = Vec::new();
    let mut test_mode = false;
    let mut test_timeout = None;
    let mut args = env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--pdfium-library" => pdfium_library = args.next().map(PathBuf::from),
            "--session-id" => session_id = args.next(),
            "--workspace-root" => workspace_root = args.next().map(PathBuf::from),
            "--source-file" => source_file = args.next().map(PathBuf::from),
            "--inspector-program" => inspector_program = args.next().map(PathBuf::from),
            "--inspector-arg" => inspector_arguments.push(
                args.next()
                    .ok_or_else(|| "missing inspector argument value".to_string())?,
            ),
            "--test-mode" => test_mode = true,
            "--test-timeout-ms" => {
                let value = args
                    .next()
                    .ok_or_else(|| "missing test timeout value".to_string())?
                    .parse::<u64>()
                    .map_err(|_| "invalid test timeout value".to_string())?;
                test_timeout = Some(Duration::from_millis(value));
            }
            _ => return Err("unsupported worker argument".into()),
        }
    }
    if test_timeout.is_some() && !test_mode {
        return Err("test timeout requires test mode".into());
    }
    Ok(Config {
        pdfium_library: pdfium_library
            .ok_or_else(|| "explicit PDFium library argument is required".to_string())?,
        session_id: session_id
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "non-empty worker session ID is required".to_string())?,
        workspace_root: workspace_root
            .ok_or_else(|| "explicit workspace root argument is required".to_string())?,
        source_file: source_file
            .ok_or_else(|| "explicit source file argument is required".to_string())?,
        inspector_program,
        inspector_arguments,
        test_mode,
        test_timeout,
    })
}

fn native_worker(
    library_path: PathBuf,
    session_id: String,
    mut workspace: Option<SessionWorkspace>,
    inspector: Box<dyn ResourceInspector>,
    startup: mpsc::SyncSender<Result<(), String>>,
    jobs: mpsc::Receiver<NativeJob>,
    test_mode: bool,
) {
    let bindings: Box<dyn PdfiumLibraryBindings> = match Pdfium::bind_to_library(&library_path) {
        Ok(bindings) => bindings,
        Err(_) => {
            let _ = startup.send(Err("pinned PDFium library could not be loaded".into()));
            return;
        }
    };
    let pdfium = Pdfium::new(bindings);
    let _ = startup.send(Ok(()));
    let mut sequence = 0_u64;
    let mut document: Option<PdfDocument<'_>> = None;
    let mut registry = ObjectRegistry::new(session_id);
    while let Ok(job) = jobs.recv() {
        sequence += 1;
        if test_mode {
            if job.request.payload.get("testCrash") == Some(&Value::Bool(true)) {
                panic!("intentional test-only native worker crash");
            }
            if let Some(delay) = job
                .request
                .payload
                .get("testDelayMs")
                .and_then(Value::as_u64)
            {
                thread::sleep(Duration::from_millis(delay));
            }
        }
        let (reply, shutdown) = execute_native(
            &pdfium,
            &mut document,
            &mut workspace,
            inspector.as_ref(),
            &mut registry,
            &job.request,
            job.revision,
            sequence,
        );
        let _ = job.reply.send(NativeOutcome { reply, shutdown });
        if shutdown {
            break;
        }
    }
    drop(document.take());
    if let Some(workspace) = workspace.take() {
        let _ = workspace.cleanup();
    }
}

fn execute_native<'a>(
    pdfium: &'a Pdfium,
    document: &mut Option<PdfDocument<'a>>,
    workspace: &mut Option<SessionWorkspace>,
    inspector: &dyn ResourceInspector,
    registry: &mut ObjectRegistry,
    request: &Request,
    revision: u64,
    sequence: u64,
) -> (Reply, bool) {
    let result = match request.command.as_str() {
        "open" => {
            let Some(active_workspace) = workspace.as_ref() else {
                return (
                    Reply::unknown(
                        &request.session_id,
                        &request.request_id,
                        revision,
                        "private workspace is unavailable",
                    ),
                    false,
                );
            };
            if document.is_none() {
                match pdfium.load_pdf_from_file(active_workspace.source_path(), None) {
                    Ok(opened) => *document = Some(opened),
                    Err(_) => {
                        return (
                            Reply::rejected(
                                request,
                                revision,
                                "rejected",
                                "REJECTED_UNSUPPORTED_STRUCTURE",
                                "source PDF could not be opened by the pinned engine",
                            ),
                            false,
                        )
                    }
                }
            }
            let page_count = document
                .as_ref()
                .map(|opened| opened.pages().len())
                .unwrap_or(0);
            if page_count > 256 {
                drop(document.take());
                return (
                    Reply::rejected(
                        request,
                        revision,
                        "rejected",
                        "REJECTED_UNSUPPORTED_STRUCTURE",
                        "source PDF exceeds the configured page limit",
                    ),
                    false,
                );
            }
            Reply::accepted(
                request,
                revision,
                json!({
                    "workerReady": true,
                    "executionSequence": sequence,
                    "pageCount": page_count,
                    "sourceBytes": active_workspace.source_bytes(),
                    "sourceSha256": active_workspace.source_hash(),
                    "engine": {
                        "wrapper": PDFIUM_RENDER_VERSION,
                        "buildIdentity": PDFIUM_BUILD_IDENTITY,
                        "librarySha256": PDFIUM_LIBRARY_SHA256,
                    }
                }),
            )
        }
        "inspect" => {
            let Some(active_workspace) = workspace.as_ref() else {
                return (
                    Reply::unknown(
                        &request.session_id,
                        &request.request_id,
                        revision,
                        "private workspace is unavailable",
                    ),
                    false,
                );
            };
            if document.is_none() {
                Reply::rejected(
                    request,
                    revision,
                    "rejected",
                    "REJECTED_UNSUPPORTED_STRUCTURE",
                    "source PDF is not open",
                )
            } else if request.payload.get("operation").and_then(Value::as_str) == Some("hitTest") {
                let point = request.payload.get("point");
                let page_index = request
                    .payload
                    .get("pageIndex")
                    .and_then(Value::as_u64)
                    .and_then(|value| u16::try_from(value).ok());
                let x = point
                    .and_then(|value| value.get("x"))
                    .and_then(Value::as_f64);
                let y = point
                    .and_then(|value| value.get("y"))
                    .and_then(Value::as_f64);
                let input_point = match (x, y) {
                    (Some(x), Some(y)) if x.is_finite() && y.is_finite() => Some(Point {
                        x: x as f32,
                        y: y as f32,
                    }),
                    _ => None,
                };
                let pdf_point = if request
                    .payload
                    .get("coordinateSpace")
                    .and_then(Value::as_str)
                    == Some("viewportCss")
                {
                    request
                        .payload
                        .get("viewportTransform")
                        .cloned()
                        .and_then(|value| serde_json::from_value::<ViewportTransform>(value).ok())
                        .and_then(|transform| {
                            input_point.and_then(|point| transform.viewport_css_to_pdf(point).ok())
                        })
                } else {
                    input_point
                };
                match (page_index, pdf_point) {
                    (Some(page_index), Some(pdf_point)) => Reply::accepted(
                        request,
                        revision,
                        json!({
                            "workerReady": true,
                            "readOnly": true,
                            "executionSequence": sequence,
                            "hitTest": hit_test(
                                registry,
                                request.expected_accepted_revision.unwrap_or(revision),
                                page_index,
                                pdf_point,
                                request.target_id.as_deref(),
                            ),
                        }),
                    ),
                    _ => Reply::rejected(
                        request,
                        revision,
                        "rejected",
                        "REJECTED_UNSUPPORTED_STRUCTURE",
                        "hit-test requires a valid page index and PDF-space point",
                    ),
                }
            } else if request.payload.get("operation").and_then(Value::as_str) == Some("preflight")
            {
                let mut preflight_payload = request.payload.clone();
                preflight_payload.remove("operation");
                match serde_json::from_value::<PreflightInput>(Value::Object(preflight_payload)) {
                    Ok(input) => {
                        let inspection = match inspector.inspect(active_workspace.source_path()) {
                            InspectionOutcome::Supported(value) => value,
                            InspectionOutcome::Unsupported => json!({"supported": false}),
                        };
                        let report = evaluate_preflight(
                            registry,
                            revision,
                            request.target_id.as_deref().unwrap_or(""),
                            &input,
                            &inspection,
                            active_workspace.source_hash(),
                        );
                        let eligible = report.eligible;
                        let primary_reason = report.primary_guard_reason.clone();
                        let result = json!({
                            "workerReady": true,
                            "readOnly": true,
                            "executionSequence": sequence,
                            "preflight": report,
                        });
                        if eligible {
                            Reply::accepted(request, revision, result)
                        } else {
                            Reply::guard_rejected(
                                request,
                                revision,
                                primary_reason
                                    .as_deref()
                                    .unwrap_or("REJECTED_UNSUPPORTED_STRUCTURE"),
                                result,
                            )
                        }
                    }
                    Err(_) => {
                        let report = rejected_preflight_report(
                            revision,
                            request.target_id.as_deref().unwrap_or(""),
                            active_workspace.source_hash(),
                            "REJECTED_UNSUPPORTED_STRUCTURE",
                        );
                        Reply::guard_rejected(
                            request,
                            revision,
                            "REJECTED_UNSUPPORTED_STRUCTURE",
                            json!({
                                "workerReady": true,
                                "readOnly": true,
                                "executionSequence": sequence,
                                "preflight": report,
                            }),
                        )
                    }
                }
            } else if request.payload.get("operation").and_then(Value::as_str)
                == Some("validateTextRange")
            {
                let target_id = request.target_id.as_deref().unwrap_or("");
                let start = request.payload.get("utf16Start").and_then(Value::as_u64);
                let end = request.payload.get("utf16End").and_then(Value::as_u64);
                let expected_text = request.payload.get("expectedText").and_then(Value::as_str);
                match registry.resolve(revision, target_id) {
                    Ok(record)
                        if expected_text == Some(record.text.as_str())
                            && start.is_some()
                            && end.is_some() =>
                    {
                        match utf16_range_to_scalar(
                            &record.text,
                            start.unwrap() as usize,
                            end.unwrap() as usize,
                        ) {
                            Ok(range) => Reply::accepted(
                                request,
                                revision,
                                json!({
                                    "workerReady": true,
                                    "readOnly": true,
                                    "executionSequence": sequence,
                                    "targetId": target_id,
                                    "unicodeRange": {
                                        "schemaVersion": "edit-content-unicode-range/v1",
                                        "unit": "unicode-scalar",
                                        "scalarStart": range.scalar_start,
                                        "scalarEnd": range.scalar_end,
                                        "startInclusive": true,
                                        "endExclusive": true,
                                    },
                                    "exactObjectTextMatched": true,
                                    "mutationCommandCreated": false,
                                }),
                            ),
                            Err(_) => Reply::rejected(
                                request,
                                revision,
                                "rejected",
                                "REJECTED_UNSUPPORTED_STRUCTURE",
                                "text range is not on exact Unicode scalar boundaries",
                            ),
                        }
                    }
                    Ok(_) => Reply::rejected(
                        request,
                        revision,
                        "rejected",
                        "REJECTED_UNSUPPORTED_STRUCTURE",
                        "text range does not match the current native object",
                    ),
                    Err(ResolveError::StaleRevision) => Reply::rejected(
                        request,
                        revision,
                        "stale",
                        "REJECTED_STALE_REVISION",
                        "text range revision is stale",
                    ),
                    Err(ResolveError::ExpiredTarget | ResolveError::LegacyDescriptor) => {
                        Reply::rejected(
                            request,
                            revision,
                            "stale",
                            "REJECTED_STALE_TARGET",
                            "text range target is expired or legacy",
                        )
                    }
                }
            } else {
                match inspector.inspect(active_workspace.source_path()) {
                    InspectionOutcome::Supported(inspection) => match discover_document(
                        document.as_ref().unwrap(),
                        &inspection,
                        registry,
                        revision,
                    ) {
                        Ok(discovery) => Reply::accepted(
                            request,
                            revision,
                            json!({
                                "workerReady": true,
                                "readOnly": true,
                                "executionSequence": sequence,
                                "inspection": inspection,
                                "discovery": discovery,
                            }),
                        ),
                        Err(error) => Reply::rejected(
                            request,
                            revision,
                            "rejected",
                            "REJECTED_UNSUPPORTED_STRUCTURE",
                            &format!("native object discovery failed closed: {error}"),
                        ),
                    },
                    InspectionOutcome::Unsupported => Reply::rejected(
                        request,
                        revision,
                        "rejected",
                        "REJECTED_UNSUPPORTED_STRUCTURE",
                        "resource inspection is unavailable for this document",
                    ),
                }
            }
        }
        "render" => {
            let Some(opened) = document.as_ref() else {
                return (
                    Reply::rejected(
                        request,
                        revision,
                        "rejected",
                        "REJECTED_UNSUPPORTED_STRUCTURE",
                        "source PDF is not open",
                    ),
                    false,
                );
            };
            let page_index = request
                .payload
                .get("pageIndex")
                .and_then(Value::as_u64)
                .and_then(|value| i32::try_from(value).ok());
            let width = request
                .payload
                .get("widthPx")
                .and_then(Value::as_u64)
                .and_then(|value| i32::try_from(value).ok());
            let height = request
                .payload
                .get("heightPx")
                .and_then(Value::as_u64)
                .and_then(|value| i32::try_from(value).ok());
            match (page_index, width, height) {
                (Some(page_index), Some(width), Some(height))
                    if (1..=4096).contains(&width) && (1..=4096).contains(&height) =>
                {
                    match render_page_jpeg(opened, page_index, width, height) {
                        Ok((bytes, rendered_width, rendered_height)) => {
                            if bytes.len().saturating_mul(4) / 3 > MAX_REPLY_BYTES - 4096 {
                                Reply::rejected(
                                    request,
                                    revision,
                                    "rejected",
                                    "REJECTED_UNSUPPORTED_STRUCTURE",
                                    "native render exceeds the configured response limit",
                                )
                            } else {
                                let sha256 =
                                    sha256_reader(&mut Cursor::new(&bytes)).unwrap_or_default();
                                Reply::accepted(
                                    request,
                                    revision,
                                    json!({
                                        "workerReady": true,
                                        "readOnly": true,
                                        "executionSequence": sequence,
                                        "pageIndex": page_index,
                                        "widthPx": rendered_width,
                                        "heightPx": rendered_height,
                                        "mimeType": "image/jpeg",
                                        "dataBase64": base64_encode(&bytes),
                                        "sha256": sha256,
                                        "mutationCommandCreated": false,
                                    }),
                                )
                            }
                        }
                        Err(_) => Reply::rejected(
                            request,
                            revision,
                            "rejected",
                            "REJECTED_UNSUPPORTED_STRUCTURE",
                            "native page rendering failed",
                        ),
                    }
                }
                _ => Reply::rejected(
                    request,
                    revision,
                    "rejected",
                    "REJECTED_UNSUPPORTED_STRUCTURE",
                    "render requires a valid page index and dimensions",
                ),
            }
        }
        "close" => {
            // The native handle is released before any private files are removed.
            drop(document.take());
            let cleanup = workspace
                .take()
                .ok_or(())
                .and_then(|active| active.cleanup().map_err(|_| ()));
            if cleanup.is_ok() {
                Reply::accepted(
                    request,
                    revision,
                    json!({
                        "closed": true,
                        "sourceHashPreserved": true,
                        "executionSequence": sequence,
                    }),
                )
            } else {
                Reply::unknown(
                    &request.session_id,
                    &request.request_id,
                    revision,
                    "private workspace cleanup failed",
                )
            }
        }
        _ => Reply::rejected(
            request,
            revision,
            "rejected",
            "REJECTED_UNSUPPORTED_STRUCTURE",
            "command is unavailable in the read-only worker foundation",
        ),
    };
    (result, request.command == "close")
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);
        result.push(TABLE[(first >> 2) as usize] as char);
        result.push(TABLE[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        result.push(if chunk.len() > 1 {
            TABLE[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        result.push(if chunk.len() > 2 {
            TABLE[(third & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    result
}

fn render_page_jpeg(
    document: &PdfDocument<'_>,
    page_index: i32,
    width: i32,
    height: i32,
) -> Result<(Vec<u8>, i32, i32), ()> {
    let page = document.pages().get(page_index).map_err(|_| ())?;
    let bitmap = page.render(width, height, None).map_err(|_| ())?;
    let image = bitmap.as_image().map_err(|_| ())?;
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 90)
        .encode_image(&image)
        .map_err(|_| ())?;
    Ok((bytes, bitmap.width(), bitmap.height()))
}

fn input_loop<W: io::Write + Send + 'static>(
    sender: mpsc::SyncSender<Request>,
    writer: SharedWriter<W>,
    session_id: String,
) {
    let mut input = BufReader::new(io::stdin());
    loop {
        match read_frame(&mut input) {
            Ok(FrameRead::Request(request)) => match sender.try_send(request) {
                Ok(()) => {}
                Err(mpsc::TrySendError::Full(request)) => send_backpressure(&writer, &request, 0),
                Err(mpsc::TrySendError::Disconnected(_)) => break,
            },
            Ok(FrameRead::Malformed(error)) => {
                let reply = Reply::unknown(&session_id, "unknown", 0, &error);
                let _ = send_reply(&writer, &reply);
            }
            Ok(FrameRead::Oversized) => {
                let reply = Reply::unknown(
                    &session_id,
                    "unknown",
                    0,
                    "request frame exceeds configured limit",
                );
                let _ = send_reply(&writer, &reply);
                break;
            }
            Ok(FrameRead::End) => break,
            Err(_) => break,
        }
    }
}

fn run(config: Config) -> Result<(), String> {
    verify_pdfium_library(&config.pdfium_library)?;
    let cancellation = CancellationToken::default();
    let workspace = SessionWorkspace::create(
        &config.workspace_root,
        &config.source_file,
        &config.session_id,
        &cancellation,
    )
    .map_err(|error| format!("private workspace setup failed: {error:?}"))?;
    let inspector: Box<dyn ResourceInspector> = match config.inspector_program {
        Some(program) => Box::new(ProcessResourceInspector::new(
            program,
            config.inspector_arguments,
        )),
        None if config.test_mode => Box::new(TestResourceInspector),
        None => Box::new(UnavailableResourceInspector),
    };
    let (job_sender, job_receiver) = mpsc::sync_channel::<NativeJob>(0);
    let (startup_sender, startup_receiver) = mpsc::sync_channel(1);
    let library_path = config.pdfium_library.clone();
    let native_session_id = config.session_id.clone();
    let test_mode = config.test_mode;
    let native = thread::spawn(move || {
        native_worker(
            library_path,
            native_session_id,
            Some(workspace),
            inspector,
            startup_sender,
            job_receiver,
            test_mode,
        )
    });
    match startup_receiver.recv_timeout(STARTUP_TIMEOUT) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return Err(error),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            return Err("pinned PDFium startup timed out".into())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err("pinned PDFium startup failed".into())
        }
    }

    let writer = Arc::new(Mutex::new(BufWriter::new(io::stdout())));
    let (request_sender, request_receiver) = bounded_request_channel();
    let input_writer = Arc::clone(&writer);
    let input_session = config.session_id.clone();
    thread::spawn(move || input_loop(request_sender, input_writer, input_session));

    let mut ledger = RequestLedger::new();
    let revision = 0_u64;
    while let Ok(request) = request_receiver.recv() {
        if let Some(original) = ledger.outcome(&request.request_id) {
            let reply = duplicate_reply(&request, revision, original);
            send_reply(&writer, &reply).map_err(|_| "protocol output failed".to_string())?;
            continue;
        }
        if let Err((reason, error)) = validate_request(&request, &config.session_id) {
            let status = if reason == "REJECTED_STALE_REVISION" {
                "stale"
            } else {
                "rejected"
            };
            let reply = Reply::rejected(&request, revision, status, reason, error);
            ledger.remember(request.request_id.clone(), reply.clone());
            send_reply(&writer, &reply).map_err(|_| "protocol output failed".to_string())?;
            continue;
        }
        if request.command != "open" && request.expected_accepted_revision != Some(revision) {
            let reply = Reply::rejected(
                &request,
                revision,
                "stale",
                "REJECTED_STALE_REVISION",
                "request revision is not current",
            );
            ledger.remember(request.request_id.clone(), reply.clone());
            send_reply(&writer, &reply).map_err(|_| "protocol output failed".to_string())?;
            continue;
        }

        let request_id = request.request_id.clone();
        let request_session = request.session_id.clone();
        let command_timeout = config
            .test_timeout
            .unwrap_or_else(|| timeout_for(&request.command));
        let (response_sender, response_receiver) = mpsc::sync_channel(1);
        job_sender
            .send(NativeJob {
                request,
                revision,
                reply: response_sender,
            })
            .map_err(|_| "native worker exited".to_string())?;
        match response_receiver.recv_timeout(command_timeout) {
            Ok(outcome) => {
                ledger.remember(request_id, outcome.reply.clone());
                send_reply(&writer, &outcome.reply)
                    .map_err(|_| "protocol output failed".to_string())?;
                if outcome.shutdown {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let reply = Reply::unknown(
                    &request_session,
                    &request_id,
                    revision,
                    "native command timed out; worker terminated",
                );
                let _ = send_reply(&writer, &reply);
                return Err("native command timeout".into());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let reply = Reply::unknown(
                    &request_session,
                    &request_id,
                    revision,
                    "native worker exited; request outcome is unknown",
                );
                let _ = send_reply(&writer, &reply);
                return Err("native worker exited".into());
            }
        }
    }
    drop(job_sender);
    native
        .join()
        .map_err(|_| "native worker exited".to_string())?;
    Ok(())
}

fn main() -> ExitCode {
    match parse_config().and_then(run) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("edit-content-engine: {error}");
            ExitCode::FAILURE
        }
    }
}
