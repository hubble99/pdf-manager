//! Survey of real PDFs: prepares one guarded edit per sampled text object and
//! tallies the verdicts. Needs documents that are not in the repository, so it
//! is ignored by default:
//!
//! `EDIT_CONTENT_UAT_DIR=<folder of pdfs> EDIT_CONTENT_UAT_SAMPLE=25 \
//!  EDIT_CONTENT_TEST_PDFIUM_PATH=<libpdfium> cargo test --release --test uat_survey -- --ignored --nocapture`
//!
//! The edit reverses the first word of an object, so it only uses glyphs the
//! font already has: a rejection is about the document, not about the text.
//! Nothing but page numbers, object indices and codes is printed.

use edit_content_engine::{sha256_reader, Reply, REQUEST_SCHEMA};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::env;
use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

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
    fn open(pdf_path: &Path) -> Result<Self, String> {
        let library = env::var_os("EDIT_CONTENT_TEST_PDFIUM_PATH")
            .map(PathBuf::from)
            .expect("EDIT_CONTENT_TEST_PDFIUM_PATH must identify the pinned phase-1 library");
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let workspace_root = env::temp_dir().join(format!("edit-content-survey-root-{unique}"));
        let source = env::temp_dir().join(format!("edit-content-survey-source-{unique}.pdf"));
        std::fs::create_dir(&workspace_root).unwrap();
        std::fs::copy(pdf_path, &source).unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_edit-content-engine"));
        command
            .args(["--pdfium-library", library.to_str().unwrap()])
            .args(["--session-id", "session-survey"])
            .args(["--workspace-root", workspace_root.to_str().unwrap()])
            .args(["--source-file", source.to_str().unwrap()])
            .arg("--native-inspector");
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
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
        if opened.status != "accepted" {
            let _ = worker.child.kill();
            let _ = std::fs::remove_dir_all(&worker.workspace_root);
            let _ = std::fs::remove_file(&worker.source);
            return Err(format!("open {} {:?}", opened.status, opened.guard_reason));
        }
        Ok(worker)
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
            "sessionId": "session-survey",
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
    fn objects(&mut self) -> Result<Vec<Value>, String> {
        let reply = self.call("inspect", Some(0), json!({}), None);
        if reply.status != "accepted" {
            return Err(format!("inspect {} {:?}", reply.status, reply.guard_reason));
        }
        Ok(reply.result["discovery"]["textObjects"].as_array().cloned().unwrap_or_default())
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
        let _ = closed;
        drop(self.input);
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.workspace_root);
        let _ = std::fs::remove_file(&self.source);
    }
}


fn first_word_edit(full: &str) -> Option<Value> {
    let start = full.char_indices().find(|(_, c)| c.is_alphanumeric())?.0;
    let word: String = full[start..].chars().take_while(|c| c.is_alphanumeric()).collect();
    if word.chars().count() < 2 {
        return None;
    }
    let reversed: String = word.chars().rev().collect();
    if reversed == word {
        return None;
    }
    let utf16_start = full[..start].encode_utf16().count();
    Some(json!({
        "expectedText": full, "expectedOldText": word, "replacementText": reversed,
        "utf16Start": utf16_start, "utf16End": utf16_start + word.encode_utf16().count(),
    }))
}

#[test]
#[ignore = "survey of real PDFs; run by hand"]
fn survey_real_pdfs() {
    let Some(dir) = env::var_os("EDIT_CONTENT_UAT_DIR").map(PathBuf::from) else {
        eprintln!("EDIT_CONTENT_UAT_DIR is not set");
        return;
    };
    let sample: usize = env::var("EDIT_CONTENT_UAT_SAMPLE").ok().and_then(|v| v.parse().ok()).unwrap_or(25);
    let only = env::var("EDIT_CONTENT_UAT_ONLY").ok();
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "pdf")).collect();
    files.sort();
    for (number, pdf) in files.iter().enumerate() {
        if only.as_deref().is_some_and(|o| o != (number + 1).to_string()) {
            continue;
        }
        let mut worker = match Worker::open(pdf) {
            Ok(worker) => worker,
            Err(why) => {
                eprintln!("[{}] not opened: {why}", number + 1);
                continue;
            }
        };
        let objects = match worker.objects() {
            Ok(objects) => objects,
            Err(why) => {
                eprintln!("[{}] not inspected: {why}", number + 1);
                worker.close();
                continue;
            }
        };
        let editable: Vec<&Value> = objects.iter().filter(|o| o["editable"] == true).collect();
        let step = (editable.len() / sample.max(1)).max(1);
        let mut prepared = 0;
        let mut tally: BTreeMap<String, usize> = BTreeMap::new();
        let mut failures = Vec::new();
        let mut slowest = 0u128;
        let mut tried = 0;
        for object in editable.iter().step_by(step) {
            if tried >= sample {
                break;
            }
            let Some(edit) = object["text"].as_str().and_then(first_word_edit) else { continue };
            let target = object["targetId"].as_str().unwrap().to_string();
            let started = Instant::now();
            let reply = worker.apply(&target, &edit);
            slowest = slowest.max(started.elapsed().as_millis());
            tried += 1;
            if reply.status == "prepared" {
                prepared += 1;
            } else {
                let reason = reply.guard_reason.clone().unwrap_or_else(|| reply.status.clone());
                *tally.entry(reason.clone()).or_default() += 1;
                let details: Vec<String> = reply.result["verificationResults"]["checks"].as_array().into_iter().flatten()
                    .filter(|c| c["passed"] == false || c["status"] == "failed")
                    .map(|c| c["name"].as_str().unwrap_or("?").to_string()).collect();
                failures.push(format!("page {} path {} {reason} {details:?} {}", object["pageIndex"], object["sourceScope"]["objectPath"], reply.error.clone().unwrap_or_default()));
            }
        }
        eprintln!("[{}] {} objects, {} editable, tried {tried}, prepared {prepared} ({}%), slowest {slowest} ms, rejections {tally:?}",
            number + 1, objects.len(), editable.len(), if tried == 0 { 0 } else { prepared * 100 / tried });
        for failure in failures {
            eprintln!("    {failure}");
        }
        worker.close();
    }
}
