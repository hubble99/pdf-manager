//! Private, preflight-gated regeneration. A candidate is never an accepted edit.

use crate::identity::{utf16_range_to_scalar, ObjectRegistry, TargetRecord};
use crate::preflight::{evaluate_preflight, PreflightInput};
use crate::resource_inspector::{InspectionOutcome, ResourceInspector};
use crate::sha256_reader;
use crate::verification::{capture, Snapshot};
use crate::workspace::{CancellationToken, SessionWorkspace, WorkspaceArea, MAX_SOURCE_BYTES};
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static CANDIDATE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditExpectation {
    pub target: TargetRecord,
    pub scalar_start: usize,
    pub scalar_end: usize,
    pub old_text: String,
    pub replacement_text: String,
    pub resulting_text: String,
    pub removed: bool,
    pub object_count_delta: i32,
}

impl EditExpectation {
    pub fn derive(target: &TargetRecord, input: &PreflightInput) -> Result<Self, &'static str> {
        if target.text != input.expected_text || input.expected_old_text.is_empty() {
            return Err("REJECTED_TARGET_NOT_FOUND");
        }
        let range = utf16_range_to_scalar(&target.text, input.utf16_start, input.utf16_end)
            .map_err(|_| "REJECTED_UNSUPPORTED_STRUCTURE")?;
        let chars: Vec<_> = target.text.chars().collect();
        if chars[range.scalar_start..range.scalar_end]
            .iter()
            .collect::<String>()
            != input.expected_old_text
        {
            return Err("REJECTED_TARGET_NOT_FOUND");
        }
        let resulting_text = format!(
            "{}{}{}",
            chars[..range.scalar_start].iter().collect::<String>(),
            input.replacement_text,
            chars[range.scalar_end..].iter().collect::<String>()
        );
        let removed = resulting_text.is_empty();
        Ok(Self {
            target: target.clone(),
            scalar_start: range.scalar_start,
            scalar_end: range.scalar_end,
            old_text: input.expected_old_text.clone(),
            replacement_text: input.replacement_text.clone(),
            resulting_text,
            removed,
            object_count_delta: if removed { -1 } else { 0 },
        })
    }
}

/// Paths are worker-private and must not be serialized into replies/history.
pub struct Candidate {
    pub path: PathBuf,
    pub sha256: String,
    pub bytes: u64,
    pub baseline_sha256: String,
    pub revision: u64,
    pub expectation: EditExpectation,
    pub baseline: Snapshot,
    pub checkpoint_id: String,
    pub source_sha256: String,
}

/// Supplied only by the coordinator's committed state, never a user path.
pub struct AcceptedCheckpointRef<'a> {
    pub path: &'a Path,
    pub sha256: &'a str,
    pub checkpoint_id: &'a str,
    pub revision: u64,
}

pub fn file_hash(path: &Path) -> Result<String, &'static str> {
    let mut file = File::open(path).map_err(|_| "REJECTED_PERSISTENCE")?;
    sha256_reader(&mut file).map_err(|_| "REJECTED_PERSISTENCE")
}

pub fn prepare_candidate(
    pdfium: &Pdfium,
    workspace: &SessionWorkspace,
    registry: &ObjectRegistry,
    revision: u64,
    target_id: &str,
    input: &PreflightInput,
    inspector: &dyn ResourceInspector,
) -> Result<Candidate, &'static str> {
    // Initial-source convenience for the isolated foundation harness.
    if revision != 0 {
        return Err("REJECTED_STALE_REVISION");
    }
    prepare_from_checkpoint(
        pdfium,
        workspace,
        &AcceptedCheckpointRef {
            path: workspace.source_path(),
            sha256: workspace.source_hash(),
            checkpoint_id: "source",
            revision,
        },
        registry,
        target_id,
        input,
        inspector,
        &CancellationToken::default(),
    )
}

pub fn prepare_from_checkpoint(
    pdfium: &Pdfium,
    workspace: &SessionWorkspace,
    accepted: &AcceptedCheckpointRef<'_>,
    registry: &ObjectRegistry,
    target_id: &str,
    input: &PreflightInput,
    inspector: &dyn ResourceInspector,
    cancellation: &CancellationToken,
) -> Result<Candidate, &'static str> {
    let mut observe = |_: RegenerationStage| Ok(());
    prepare_from_checkpoint_observed(
        pdfium,
        workspace,
        accepted,
        registry,
        target_id,
        input,
        inspector,
        cancellation,
        &mut observe,
    )
}

fn prepare_from_checkpoint_observed(
    pdfium: &Pdfium,
    workspace: &SessionWorkspace,
    accepted: &AcceptedCheckpointRef<'_>,
    registry: &ObjectRegistry,
    target_id: &str,
    input: &PreflightInput,
    inspector: &dyn ResourceInspector,
    cancellation: &CancellationToken,
    observe: &mut dyn FnMut(RegenerationStage) -> Result<(), &'static str>,
) -> Result<Candidate, &'static str> {
    let revision = accepted.revision;
    cancellation.check().map_err(|_| "CANCELLED")?;
    workspace
        .verify_source_hash()
        .map_err(|_| "REJECTED_PERSISTENCE")?;
    let metadata = fs::symlink_metadata(accepted.path).map_err(|_| "REJECTED_PERSISTENCE")?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_SOURCE_BYTES
        || accepted.checkpoint_id.is_empty()
        || file_hash(accepted.path)? != accepted.sha256
    {
        return Err("REJECTED_PERSISTENCE");
    }
    let target = registry
        .resolve(revision, target_id)
        .map_err(|_| "REJECTED_STALE_REVISION")?;
    let inspection = match inspector.inspect(accepted.path) {
        InspectionOutcome::Supported(value) => value,
        InspectionOutcome::Unsupported => return Err("REJECTED_UNSUPPORTED_STRUCTURE"),
    };
    let guard = evaluate_preflight(
        registry,
        revision,
        target_id,
        input,
        &inspection,
        accepted.sha256,
    );
    if !guard.eligible {
        return Err(match guard.primary_guard_reason.as_deref() {
            Some("REJECTED_SPLIT_TEXT_OBJECT") => "REJECTED_SPLIT_TEXT_OBJECT",
            Some("REJECTED_TYPE3") => "REJECTED_TYPE3",
            Some("REJECTED_UNSUPPORTED_GLYPH") => "REJECTED_UNSUPPORTED_GLYPH",
            Some("REJECTED_FONT_RESOURCE_COLLISION") => "REJECTED_FONT_RESOURCE_COLLISION",
            _ => "REJECTED_UNSUPPORTED_STRUCTURE",
        });
    }
    let expectation = EditExpectation::derive(target, input)?;
    let baseline = capture(pdfium, accepted.path, inspector, revision)?;
    if baseline.artifact_hash != accepted.sha256 {
        return Err("REJECTED_PERSISTENCE");
    }
    cancellation.check().map_err(|_| "CANCELLED")?;
    let sequence = CANDIDATE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let name = format!("candidate-{}-{sequence}.pdf", std::process::id());
    let working = workspace
        .contained_path(WorkspaceArea::Working, Path::new(&name))
        .map_err(|_| "REJECTED_PERSISTENCE")?;
    let path = workspace
        .contained_path(WorkspaceArea::Staging, Path::new(&name))
        .map_err(|_| "REJECTED_PERSISTENCE")?;
    // Never overwrite any existing file, even in owned storage.
    let mut copy = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&working)
        .map_err(|_| "REJECTED_PERSISTENCE")?;
    let mut output = match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(file) => file,
        Err(_) => {
            drop(copy);
            let _ = fs::remove_file(&working);
            return Err("REJECTED_PERSISTENCE");
        }
    };
    let result = (|| {
        let mut source = File::open(accepted.path).map_err(|_| "REJECTED_PERSISTENCE")?;
        std::io::copy(&mut source, &mut copy).map_err(|_| "REJECTED_PERSISTENCE")?;
        copy.flush().map_err(|_| "REJECTED_PERSISTENCE")?;
        drop(copy);
        if file_hash(&working)? != accepted.sha256 {
            return Err("REJECTED_PERSISTENCE");
        }
        cancellation.check().map_err(|_| "CANCELLED")?;
        regenerate_observed(pdfium, &working, &mut output, &expectation, observe)?;
        drop(output);
        let reopened = pdfium
            .load_pdf_from_file(&path, None)
            .map_err(|_| "REJECTED_PERSISTENCE")?;
        drop(reopened);
        workspace
            .verify_source_hash()
            .map_err(|_| "REJECTED_PERSISTENCE")?;
        cancellation.check().map_err(|_| "CANCELLED")?;
        if file_hash(accepted.path)? != accepted.sha256 {
            return Err("REJECTED_PERSISTENCE");
        }
        let bytes = fs::metadata(&path)
            .map_err(|_| "REJECTED_PERSISTENCE")?
            .len();
        if bytes > MAX_SOURCE_BYTES {
            return Err("REJECTED_PERSISTENCE");
        }
        Ok(Candidate {
            sha256: file_hash(&path)?,
            path: path.clone(),
            bytes,
            baseline_sha256: accepted.sha256.into(),
            revision,
            expectation,
            baseline,
            checkpoint_id: accepted.checkpoint_id.into(),
            source_sha256: workspace.source_hash().into(),
        })
    })();
    let _ = fs::remove_file(&working);
    if result.is_err() {
        let _ = fs::remove_file(&path);
    }
    result
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RegenerationStage {
    Mutated,
    Regenerated,
    BeforeSerialization,
}

fn regenerate_observed(
    pdfium: &Pdfium,
    working: &Path,
    output: &mut File,
    edit: &EditExpectation,
    observe: &mut dyn FnMut(RegenerationStage) -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    let document = pdfium
        .load_pdf_from_file(working, None)
        .map_err(|_| "REJECTED_PERSISTENCE")?;
    if edit.target.object_path.len() != 1 {
        return Err("REJECTED_UNSUPPORTED_STRUCTURE");
    }
    {
        let mut page = document
            .pages()
            .get(edit.target.page_index as _)
            .map_err(|_| "REJECTED_PERSISTENCE")?;
        {
            let mut object = page
                .objects()
                .get(edit.target.object_path[0] as _)
                .map_err(|_| "REJECTED_PERSISTENCE")?;
            let text = object
                .as_text_object_mut()
                .ok_or("REJECTED_TARGET_NOT_FOUND")?;
            if text.text() != edit.target.text {
                return Err("REJECTED_TARGET_NOT_FOUND");
            }
            if !edit.removed {
                text.set_text(&edit.resulting_text)
                    .map_err(|_| "REJECTED_PERSISTENCE")?;
                observe(RegenerationStage::Mutated)?;
                text.apply_matrix(PdfMatrix::IDENTITY)
                    .map_err(|_| "REJECTED_PERSISTENCE")?;
                observe(RegenerationStage::Regenerated)?;
            }
        }
        if edit.removed {
            // Removal triggers the wrapper's page regeneration once. No space
            // substitution, fallback, or transform of an unrelated object.
            let detached = page
                .objects_mut()
                .remove_object_at_index(edit.target.object_path[0] as _)
                .map_err(|_| "REJECTED_PERSISTENCE")?;
            drop(detached);
            observe(RegenerationStage::Mutated)?;
            observe(RegenerationStage::Regenerated)?;
        }
    }
    observe(RegenerationStage::BeforeSerialization)?;
    document
        .save_to_writer(output)
        .map_err(|_| "REJECTED_PERSISTENCE")?;
    output.flush().map_err(|_| "REJECTED_PERSISTENCE")?;
    output.sync_all().map_err(|_| "REJECTED_PERSISTENCE")?;
    drop(document);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::discover_document;
    use crate::resource_inspector::{InspectionOutcome, ProcessResourceInspector};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn write_fixture(path: &Path) {
        let stream = "BT /F1 12 Tf 30 100 Td (word) Tj ET";
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".to_string(),
            format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
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
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn stage_failures_discard_candidate_and_leave_source_and_checkpoint_unchanged() {
        let library = PathBuf::from(
            std::env::var_os("EDIT_CONTENT_TEST_PDFIUM_PATH")
                .expect("the exact pinned PDFium library is required"),
        );
        crate::verify_pdfium_library(&library).unwrap();
        let pdfium = Pdfium::new(Pdfium::bind_to_library(&library).unwrap());
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "edit-content-stage-failure-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        let source = root.join("source.pdf");
        write_fixture(&source);
        let source_hash = file_hash(&source).unwrap();
        let sessions = root.join("sessions");
        let workspace = SessionWorkspace::create(
            &sessions,
            &source,
            "stage-failure",
            &CancellationToken::default(),
        )
        .unwrap();
        let backend = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("backend");
        let inspector = ProcessResourceInspector::new(
            "env".into(),
            vec![
                format!(
                    "PYTHONPATH={}:{}",
                    backend.display(),
                    backend.join(".venv/Lib/site-packages").display()
                ),
                "python3".into(),
                backend
                    .join("features/edit_content/resource_inspector_cli.py")
                    .display()
                    .to_string(),
            ],
        );
        let InspectionOutcome::Supported(inspection) = inspector.inspect(workspace.source_path())
        else {
            panic!("real resource inspection required");
        };
        let mut registry = ObjectRegistry::new("stage-failure");
        let target = {
            let document = pdfium
                .load_pdf_from_file(workspace.source_path(), None)
                .unwrap();
            discover_document(&document, &inspection, &mut registry, 0)
                .unwrap()
                .text_objects[0]
                .target_id
                .clone()
        };
        let input = PreflightInput {
            expected_text: "word".into(),
            expected_old_text: "word".into(),
            replacement_text: "text".into(),
            utf16_start: 0,
            utf16_end: 4,
        };
        for failure in [
            RegenerationStage::Mutated,
            RegenerationStage::Regenerated,
            RegenerationStage::BeforeSerialization,
        ] {
            let accepted = AcceptedCheckpointRef {
                path: workspace.source_path(),
                sha256: workspace.source_hash(),
                checkpoint_id: "source",
                revision: 0,
            };
            let mut observe = |stage| {
                if stage == failure {
                    Err("REJECTED_PERSISTENCE")
                } else {
                    Ok(())
                }
            };
            let result = prepare_from_checkpoint_observed(
                &pdfium,
                &workspace,
                &accepted,
                &registry,
                &target,
                &input,
                &inspector,
                &CancellationToken::default(),
                &mut observe,
            );
            assert!(matches!(result, Err("REJECTED_PERSISTENCE")));
            assert_eq!(file_hash(&source).unwrap(), source_hash);
            assert_eq!(file_hash(workspace.source_path()).unwrap(), source_hash);
            assert_eq!(
                fs::read_dir(workspace.working_path().parent().unwrap())
                    .unwrap()
                    .count(),
                1
            );
            assert_eq!(
                fs::read_dir(
                    workspace
                        .contained_path(WorkspaceArea::Staging, Path::new("probe"))
                        .unwrap()
                        .parent()
                        .unwrap()
                )
                .unwrap()
                .count(),
                0
            );
        }
        workspace.cleanup().unwrap();
        fs::remove_dir(sessions).unwrap();
        fs::remove_file(source).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
