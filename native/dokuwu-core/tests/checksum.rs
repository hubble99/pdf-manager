//! End-to-end checks of the checksum operation through the job runner.

use std::io::Write;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dokuwu_core::job::{JobContext, JobOutcome, JobRunner, Progress, ProgressSink};
use dokuwu_core::ops::checksum::{sha256_file, FileDigest};

fn temp_file(bytes: &[u8]) -> tempfile::NamedTempFile {
    let mut f = tempfile::NamedTempFile::new().unwrap();
    f.write_all(bytes).unwrap();
    f.flush().unwrap();
    f
}

#[test]
fn hashes_known_content() {
    let f = temp_file(b"abc");
    let digest = sha256_file(f.path(), &JobContext::detached()).unwrap();
    assert_eq!(digest.size_bytes, 3);
    assert_eq!(
        digest.sha256,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn hashes_empty_file() {
    let f = temp_file(b"");
    let digest = sha256_file(f.path(), &JobContext::detached()).unwrap();
    assert_eq!(
        digest.sha256,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn missing_file_is_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let err = sha256_file(&dir.path().join("nope.pdf"), &JobContext::detached()).unwrap_err();
    assert_eq!(err.code(), "not_found");
}

#[test]
fn directory_is_invalid_input() {
    let dir = tempfile::tempdir().unwrap();
    let err = sha256_file(dir.path(), &JobContext::detached());
    // Windows refuses to open a directory as a file; other systems open it and
    // the metadata check rejects it.
    let code = err.unwrap_err().code();
    assert!(code == "invalid_input" || code == "io", "got {code}");
}

#[test]
fn cancelled_before_start_returns_cancelled() {
    let f = temp_file(&[7u8; 4096]);
    let ctx = JobContext::detached();
    ctx.cancel_token().cancel();
    assert!(sha256_file(f.path(), &ctx).unwrap_err().is_cancelled());
}

#[test]
fn runs_as_job_with_progress_ending_at_total() {
    // 5 MiB + 1 byte: several chunks and a short last one.
    let size = 5 * 1024 * 1024 + 1;
    let f = temp_file(&vec![1u8; size]);
    let path = f.path().to_path_buf();

    let seen: Arc<Mutex<Vec<Progress>>> = Arc::default();
    let sink: ProgressSink = {
        let seen = Arc::clone(&seen);
        Arc::new(move |_, p: &Progress| seen.lock().unwrap().push(p.clone()))
    };

    let runner = JobRunner::new();
    let (tx, rx) = mpsc::channel::<JobOutcome<FileDigest>>();
    runner
        .spawn("checksum", Some(sink), move |ctx| sha256_file(&path, ctx), move |_, out| {
            tx.send(out).unwrap()
        })
        .unwrap();

    match rx.recv_timeout(Duration::from_secs(30)).unwrap() {
        JobOutcome::Succeeded { result } => assert_eq!(result.size_bytes, size as u64),
        other => panic!("unexpected outcome: {other:?}"),
    }
    let seen = seen.lock().unwrap();
    let last = seen.last().expect("at least one progress report");
    assert_eq!(last.stage, "hashing");
    assert_eq!(last.total, Some(size as u64));
    assert_eq!(last.done, size as u64);
    assert!(seen.windows(2).all(|w| w[0].done <= w[1].done), "progress never goes back");
}
