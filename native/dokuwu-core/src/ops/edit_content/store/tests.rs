//! Commit-store behaviour on real files with synthetic bytes (not PDF proof).

use std::process::Command;

use super::*;
use crate::ops::edit_content::identity;
use crate::ops::edit_content::state::{EditMetadata, REQUIRED_CHECKS, VERIFIER_POLICY};

const SOURCE_BYTES: &[u8] = b"synthetic source checkpoint";
const CANDIDATE_BYTES: &[u8] = b"synthetic verified candidate";

fn sha(bytes: &[u8]) -> String {
    hex(Sha256::digest(bytes))
}

fn source_state(path: &Path) -> SessionState {
    fs::write(path, SOURCE_BYTES).unwrap();
    let digest = sha(SOURCE_BYTES);
    SessionState::initial(
        "session",
        Checkpoint {
            checkpoint_id: "source".into(),
            accepted_revision: 0,
            parent_accepted_revision: None,
            parent_checkpoint_id: None,
            source_hash: digest.clone(),
            accepted_artifact_hash: digest,
            byte_size: SOURCE_BYTES.len() as i64,
            object_census: vec![1],
            edit: None,
        },
    )
    .unwrap()
}

/// A worker stand-in that "prepares" the synthetic candidate for `request_id`.
fn prepared(candidate: PathBuf, request_id: &'static str, operation: &'static str) -> impl FnMut(&SessionState, &Path) -> Result<(Checkpoint, PathBuf), EditError> {
    move |state, accepted| {
        assert_eq!(sha(&fs::read(accepted).unwrap()), state.current().accepted_artifact_hash);
        fs::write(&candidate, CANDIDATE_BYTES).unwrap();
        let (engine_sha, build, wrapper) = identity::current().unwrap().verification_identity();
        let edit = EditMetadata {
            request_id: request_id.into(),
            operation: operation.into(),
            page_index: 0,
            source_scope: vec![0],
            scalar_start: 0,
            scalar_end: 4,
            before_text: "word".into(),
            after_text: "text".into(),
            occurrence_before: 1,
            occurrence_after: 0,
            object_delta: 0,
            baseline_hash: state.current().accepted_artifact_hash.clone(),
            engine_sha256: engine_sha,
            engine_build: build,
            wrapper,
            verifier_policy: VERIFIER_POLICY.into(),
            checks: REQUIRED_CHECKS.iter().map(|c| c.to_string()).collect(),
        };
        Ok((
            Checkpoint {
                checkpoint_id: format!("checkpoint_{request_id}"),
                accepted_revision: state.revision + 1,
                parent_accepted_revision: Some(state.revision),
                parent_checkpoint_id: Some(state.current().checkpoint_id.clone()),
                source_hash: state.source.source_hash.clone(),
                accepted_artifact_hash: sha(CANDIDATE_BYTES),
                byte_size: CANDIDATE_BYTES.len() as i64,
                object_census: vec![1],
                edit: Some(edit),
            },
            candidate.clone(),
        ))
    }
}

struct Fixture {
    dir: tempfile::TempDir,
    store: CommitStore,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let state = source_state(&dir.path().join("source.pdf"));
        let store = CommitStore::create(&dir.path().join("owned"), &state, &dir.path().join("source.pdf")).unwrap();
        Self { dir, store }
    }

    fn root(&self) -> PathBuf {
        self.store.root().to_path_buf()
    }

    fn candidate(&self) -> PathBuf {
        self.dir.path().join("candidate.pdf")
    }

    fn record(&self) -> Vec<u8> {
        fs::read(self.root().join("record.json")).unwrap()
    }

    fn fault_at(&self, boundary: &'static str, error: &'static str) {
        self.store.guard().fault = Some(Box::new(move |name| {
            if name == boundary {
                Err(EditError::Io(error.into()))
            } else {
                Ok(())
            }
        }));
    }

    fn tx(&self, id: &str, revision: i64, operation: &str, draft: bool) -> TxRequest<'static> {
        TxRequest {
            request_id: Box::leak(id.to_owned().into_boxed_str()),
            expected_revision: revision,
            operation: Box::leak(operation.to_owned().into_boxed_str()),
            pending_draft: draft,
        }
    }

    fn apply(&self, id: &'static str, revision: i64, operation: &'static str) -> Result<Outcome, EditError> {
        let mut worker = prepared(self.candidate(), id, operation);
        self.store.transact(&self.tx(id, revision, operation, true), Some(&mut worker), &|| false)
    }

    fn plain(&self, id: &str, revision: i64, operation: &str) -> Result<Outcome, EditError> {
        self.store.transact(&self.tx(id, revision, operation, false), None, &|| false)
    }

    fn staging_is_empty(&self) -> bool {
        fs::read_dir(self.root().join("staging")).unwrap().next().is_none()
    }
}

#[test]
fn joint_save_unchanged_save_history_and_published_output_survive() {
    let fx = Fixture::new();
    let outcome = fx.apply("edit", 0, "save-with-draft").unwrap();
    assert_eq!(outcome.revision, 1);
    let output_id = outcome.output_id.clone().unwrap();
    assert_eq!(fs::read(fx.store.verified_output(&output_id).unwrap().0).unwrap(), CANDIDATE_BYTES);
    let saved = fx.store.state().unwrap();
    let second = fx.plain("save", 1, "save").unwrap();
    assert!(second.revision == 1 && second.output_id != outcome.output_id);
    assert_eq!(fx.store.state().unwrap().checkpoints, saved.checkpoints);
    fx.plain("undo", 1, "undo").unwrap();
    let after_undo = fx.store.state().unwrap();
    assert!(after_undo.revision == 2 && after_undo.current() == &after_undo.source);
    assert_eq!(fs::read(fx.store.verified_output(&output_id).unwrap().0).unwrap(), CANDIDATE_BYTES);

    let (root, source_hash) = (fx.root(), after_undo.source.source_hash.clone());
    fx.store.close();
    let reopened = CommitStore::open(&root, "session", Some(&source_hash)).unwrap();
    assert_eq!(reopened.state().unwrap().revision, 2);
    let (path, _) = reopened.verified_output(&second.output_id.unwrap()).unwrap();
    assert_eq!(fs::read(path).unwrap(), CANDIDATE_BYTES);
}

#[test]
fn every_precommit_fault_retains_checkpoint_history_and_saved_output() {
    for boundary in [
        "before-worker",
        "after-worker",
        "before-reservation-flush",
        "before-file-flush",
        "before-artifact-install",
        "after-files-prepared",
        "before-record-flush",
        "before-record-switch",
    ] {
        let fx = Fixture::new();
        let published = fx.plain("save", 0, "save").unwrap();
        let old = fx.store.state().unwrap();
        let old_record = fx.record();
        fx.fault_at(boundary, "injected storage/worker failure");
        let error = fx.apply("edit", 0, "save-with-draft").expect_err(boundary);
        assert!(matches!(error, EditError::Io(_) | EditError::Rejected(_)), "{boundary}: {error:?}");
        assert_eq!(fx.store.state().unwrap(), old, "{boundary}");
        assert_eq!(fx.record(), old_record, "{boundary}");
        let (path, _) = fx.store.verified_output(&published.output_id.clone().unwrap()).unwrap();
        assert_eq!(fs::read(path).unwrap(), SOURCE_BYTES, "{boundary}");
        assert!(!fx.root().join("checkpoints/checkpoint_edit.pdf").exists(), "{boundary}");
        assert!(fx.staging_is_empty(), "{boundary}");
    }
}

#[test]
fn postcommit_failure_reports_recorded_success_without_replay() {
    for boundary in ["after-record-switch", "before-reply"] {
        let fx = Fixture::new();
        fx.fault_at(boundary, "reply delivery failed");
        let outcome = fx.apply("edit", 0, "apply").unwrap();
        assert!(outcome.revision == 1 && fx.store.state().unwrap().revision == 1, "{boundary}");
        assert!(fx.staging_is_empty(), "{boundary}");
        let mut must_not_run = |_: &SessionState, _: &Path| -> Result<(Checkpoint, PathBuf), EditError> {
            panic!("duplicate mutation was replayed")
        };
        let again = fx.store.transact(&fx.tx("edit", 0, "apply", true), Some(&mut must_not_run), &|| false).unwrap();
        assert_eq!(again, outcome);
        assert_eq!(fx.store.state().unwrap().checkpoints.len(), 2);
    }
}

#[test]
fn cancellation_collision_and_tampering_fail_closed() {
    let fx = Fixture::new();
    let old = fx.store.state().unwrap();
    let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = cancelled.clone();
    fx.store.guard().fault = Some(Box::new(move |name| {
        if name == "before-record-switch" {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        Ok(())
    }));
    let mut worker = prepared(fx.candidate(), "edit", "apply");
    let watch = cancelled.clone();
    let error = fx
        .store
        .transact(&fx.tx("edit", 0, "apply", true), Some(&mut worker), &move || watch.load(std::sync::atomic::Ordering::SeqCst))
        .unwrap_err();
    assert!(matches!(error, EditError::Rejected(_)));
    assert_eq!(fx.store.state().unwrap(), old);

    let (first, second) = (fx.dir.path().join("first"), fx.dir.path().join("second"));
    fs::write(&first, b"first").unwrap();
    fs::write(&second, b"second").unwrap();
    assert!(atomic_move(&first, &second, false).is_err());
    assert_eq!(fs::read(&first).unwrap(), b"first");
    assert_eq!(fs::read(&second).unwrap(), b"second");
    atomic_move(&first, &second, true).unwrap();
    assert_eq!(fs::read(&second).unwrap(), b"first");

    fs::write(fx.root().join("record.json"), b"corrupt record").unwrap();
    assert!(matches!(fx.store.state(), Err(EditError::Unknown(_))));
    assert!(matches!(fx.plain("later", 0, "save"), Err(EditError::Unknown(_))));
    assert_eq!(fx.record(), b"corrupt record");
}

#[test]
fn an_existing_artifact_is_never_replaced() {
    let fx = Fixture::new();
    let existing = fx.root().join("outputs/collision.pdf");
    fs::write(&existing, b"existing private output").unwrap();
    let inner = fx.store.guard();
    let error = fx.store.install(&inner, &fx.root().join("checkpoints/source.pdf"), &existing, &sha(SOURCE_BYTES), SOURCE_BYTES.len() as i64);
    assert!(matches!(error, Err(EditError::Io(_))));
    assert_eq!(fs::read(&existing).unwrap(), b"existing private output");
    assert!(fx.staging_is_empty());
}

#[test]
fn a_changed_candidate_is_refused_before_it_is_installed() {
    let fx = Fixture::new();
    let inner = fx.store.guard();
    let candidate = fx.candidate();
    fs::write(&candidate, b"other bytes").unwrap();
    let destination = fx.root().join("checkpoints/new.pdf");
    let error = fx.store.install(&inner, &candidate, &destination, &sha(CANDIDATE_BYTES), CANDIDATE_BYTES.len() as i64);
    assert!(matches!(error, Err(EditError::Rejected(_))));
    assert!(!destination.exists());
    fs::write(&candidate, CANDIDATE_BYTES).unwrap();
    let error = fx.store.install(&inner, &candidate, &destination, &sha(CANDIDATE_BYTES), CANDIDATE_BYTES.len() as i64 + 1);
    assert!(matches!(error, Err(EditError::Rejected(_))));
    assert!(fx.staging_is_empty());
}

#[test]
fn the_preparation_reservation_is_held_and_consumed_exactly() {
    let fx = Fixture::new();
    let inner = fx.store.guard();
    let reservation = fx.store.reserve(&inner, 4097).unwrap();
    assert_eq!(fs::metadata(&reservation).unwrap().len(), 4097);
    fx.store.consume_reservation(&reservation, 4096).unwrap();
    assert_eq!(fs::metadata(&reservation).unwrap().len(), 1);
    fx.store.consume_reservation(&reservation, 1).unwrap();
    assert_eq!(fs::metadata(&reservation).unwrap().len(), 0);
    let error = fx.store.consume_reservation(&reservation, 1).unwrap_err();
    assert!(error.to_string().contains("reservation was lost"));
    fs::remove_file(&reservation).unwrap();
}

#[test]
fn insufficient_preparation_space_rejects_without_eviction() {
    let fx = Fixture::new();
    let old = fx.store.state().unwrap();
    let old_record = fx.record();
    fx.store.guard().max_preparation = 1;
    let error = fx.apply("too-large", 0, "apply").unwrap_err();
    assert!(error.to_string().contains("preparation budget"), "{error}");
    assert_eq!(fx.store.state().unwrap(), old);
    assert_eq!(fx.record(), old_record);
    assert!(!fx.root().join("checkpoints/checkpoint_too-large.pdf").exists());
}

#[test]
fn unreferenced_orphans_are_never_promoted_on_reopen() {
    let fx = Fixture::new();
    for path in ["checkpoints/orphan.pdf", "outputs/orphan.pdf", "staging/orphan"] {
        fs::write(fx.root().join(path), b"uncommitted orphan").unwrap();
    }
    let expected = fx.store.state().unwrap();
    let (root, session_id, source_hash) = (fx.root(), "session", expected.source.source_hash.clone());
    fx.store.close();
    let reopened = CommitStore::open(&root, session_id, Some(&source_hash)).unwrap();
    assert_eq!(reopened.state().unwrap(), expected);
    let error = reopened.verified_output("orphan").unwrap_err();
    assert!(error.to_string().contains("not published"));
    assert!(root.join("checkpoints/source.pdf").exists());
}

#[test]
fn a_second_owner_cannot_take_the_same_store() {
    let fx = Fixture::new();
    let hash = fx.store.state().unwrap().source.source_hash;
    assert!(matches!(CommitStore::open(&fx.root(), "session", Some(&hash)), Err(EditError::Unknown(_))));
    fx.store.close();
    CommitStore::open(&fx.root(), "session", Some(&hash)).unwrap();
}

#[test]
fn recovery_ignores_uncommitted_candidates_and_keeps_the_saved_identity() {
    let fx = Fixture::new();
    let output = fx.plain("save", 0, "save").unwrap();
    fx.store.close();
    let candidate = fx.root().join("staging/uncommitted.pdf");
    fs::write(&candidate, b"unverified bytes").unwrap();
    let store = CommitStore::recover(&fx.root(), "session").unwrap();
    let state = store.state().unwrap();
    assert_eq!(state.revision, 0);
    assert_eq!(state.last_output_id, output.output_id);
    assert_eq!(fs::read(store.checkpoint_path().unwrap()).unwrap(), SOURCE_BYTES);
    assert_eq!(state.known_outcome("save"), Some(&output));
    assert_eq!(fs::read(&candidate).unwrap(), b"unverified bytes");
    assert!(CommitStore::recover(&fx.root(), "session").is_err());
}

#[test]
fn corrupt_recovery_fails_closed_and_retains_evidence() {
    for damage in ["record", "checkpoint", "output", "wrong-session"] {
        let fx = Fixture::new();
        let output = fx.plain("save", 0, "save").unwrap();
        fx.store.close();
        let root = fx.root();
        let path = match damage {
            "record" => root.join("record.json"),
            "checkpoint" => root.join("checkpoints/source.pdf"),
            "output" => root.join(format!("outputs/{}.pdf", output.output_id.clone().unwrap())),
            _ => {
                assert!(matches!(CommitStore::recover(&root, "other"), Err(EditError::Unknown(_))));
                continue;
            }
        };
        if damage != "record" {
            let mut permissions = fs::metadata(&path).unwrap().permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
            fs::set_permissions(&path, permissions).unwrap();
        }
        fs::write(&path, if damage == "record" { b"{}".to_vec() } else { b"tampered".to_vec() }).unwrap();
        let expected = fs::read(&path).unwrap();
        assert!(matches!(CommitStore::recover(&root, "session"), Err(EditError::Unknown(_))), "{damage}");
        assert_eq!(fs::read(&path).unwrap(), expected, "{damage}");
        assert_eq!(fs::read(fx.dir.path().join("source.pdf")).unwrap(), SOURCE_BYTES);
    }
}

/// Re-runs this test binary as a child that dies (like a killed process) at a
/// boundary inside a transaction. The parent then reopens the store.
#[test]
fn actual_process_termination_restarts_only_from_the_commit_record() {
    for (boundary, expected_revision) in [("before-record-switch", 0), ("after-record-switch", 1)] {
        let fx = Fixture::new();
        let hash = fx.store.state().unwrap().source.source_hash;
        let root = fx.root();
        fx.store.close();
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "ops::edit_content::store::tests::crash_child", "--nocapture", "--test-threads=1"])
            .env("EDIT_STORE_CRASH_ROOT", &root)
            .env("EDIT_STORE_CRASH_HASH", &hash)
            .env("EDIT_STORE_CRASH_BOUNDARY", boundary)
            .env("EDIT_STORE_CRASH_CANDIDATE", fx.candidate())
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(73), "{boundary}");
        let reopened = CommitStore::open(&root, "session", Some(&hash)).unwrap();
        let recovered = reopened.state().unwrap();
        assert_eq!(recovered.revision, expected_revision, "{boundary}");
        assert_eq!(recovered.known_outcome("edit").is_some(), expected_revision == 1, "{boundary}");
        assert_eq!(fs::read(fx.dir.path().join("source.pdf")).unwrap(), SOURCE_BYTES);
    }
}

/// The child half of the test above; does nothing in a normal run.
#[test]
fn crash_child() {
    let Some(boundary) = std::env::var("EDIT_STORE_CRASH_BOUNDARY").ok() else { return };
    let root = PathBuf::from(std::env::var("EDIT_STORE_CRASH_ROOT").unwrap());
    let hash = std::env::var("EDIT_STORE_CRASH_HASH").unwrap();
    let candidate = PathBuf::from(std::env::var("EDIT_STORE_CRASH_CANDIDATE").unwrap());
    let store = CommitStore::open(&root, "session", Some(&hash)).unwrap();
    store.guard().fault = Some(Box::new(move |name| {
        if name == boundary {
            std::process::exit(73);
        }
        Ok(())
    }));
    let mut worker = prepared(candidate, "edit", "apply");
    let request = TxRequest { request_id: "edit", expected_revision: 0, operation: "apply", pending_draft: true };
    let _ = store.transact(&request, Some(&mut worker), &|| false);
    std::process::exit(74);
}

#[test]
fn history_pruning_removes_only_evicted_checkpoint_files() {
    let fx = Fixture::new();
    for index in 1..=9_u32 {
        let id: &'static str = Box::leak(format!("e{index}").into_boxed_str());
        let candidate = fx.dir.path().join(format!("c{index}.pdf"));
        let mut worker = prepared(candidate.clone(), id, "apply");
        // Each candidate must differ, so give it its own bytes.
        let mut distinct = |state: &SessionState, accepted: &Path| {
            let (mut checkpoint, path) = worker(state, accepted)?;
            let bytes = format!("candidate {index}").into_bytes();
            fs::write(&path, &bytes).unwrap();
            checkpoint.accepted_artifact_hash = sha(&bytes);
            checkpoint.byte_size = bytes.len() as i64;
            Ok((checkpoint, path))
        };
        fx.store.transact(&fx.tx(id, index as i64 - 1, "apply", true), Some(&mut distinct), &|| false).unwrap();
    }
    let state = fx.store.state().unwrap();
    assert_eq!(state.checkpoints.len(), 8);
    let files: std::collections::BTreeSet<String> = fs::read_dir(fx.root().join("checkpoints"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    let expected: std::collections::BTreeSet<String> =
        state.checkpoints.iter().map(|c| format!("{}.pdf", c.checkpoint_id)).collect();
    assert_eq!(files, expected);
}
