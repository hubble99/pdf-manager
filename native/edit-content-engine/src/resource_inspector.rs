use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::MAX_REPLY_BYTES;

const INSPECTOR_TIMEOUT: Duration = Duration::from_secs(25);

/// Multiple names are unambiguous only when they reference the same inspected
/// dictionary with a valid semantic proof. Distinct dictionaries stay distinct,
/// even when their font names, programs, or semantic hashes happen to match.
pub(crate) fn unique_font<'a>(mut fonts: impl Iterator<Item = &'a Value>) -> Option<&'a Value> {
    let first = fonts.next()?;
    for alias in fonts {
        let identity = first["fontObject"].as_str().filter(|id| !id.is_empty())?;
        let hash = first["semanticSha256"].as_str().filter(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })?;
        if alias["fontObject"].as_str() != Some(identity)
            || alias["semanticSha256"].as_str() != Some(hash)
        {
            return None;
        }
        // The inspector must agree on all evidence, not just the fingerprint.
        let evidence = |value: &'a Value| {
            value.as_object().map(|object| {
                object
                    .iter()
                    .filter(|(key, _)| key.as_str() != "resourceName")
                    .collect::<Vec<_>>()
            })
        };
        if evidence(first)? != evidence(alias)? {
            return None;
        }
    }
    Some(first)
}

#[derive(Debug)]
pub enum InspectionOutcome {
    Supported(Value),
    Unsupported,
}

pub trait ResourceInspector: Send {
    fn inspect(&self, source: &Path) -> InspectionOutcome;
}

pub struct ProcessResourceInspector {
    program: PathBuf,
    arguments: Vec<String>,
}

impl ProcessResourceInspector {
    pub fn new(program: PathBuf, arguments: Vec<String>) -> Self {
        Self { program, arguments }
    }
}

impl ResourceInspector for ProcessResourceInspector {
    fn inspect(&self, source: &Path) -> InspectionOutcome {
        let mut command = Command::new(&self.program);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW for the console sidecar.
        }
        let mut child = match command
            .args(&self.arguments)
            .arg("--input")
            .arg(source)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(_) => return InspectionOutcome::Unsupported,
        };
        let Some(mut stdout) = child.stdout.take() else {
            let _ = child.kill();
            return InspectionOutcome::Unsupported;
        };
        let reader = thread::spawn(move || {
            let mut collected = Vec::new();
            let mut buffer = [0_u8; 64 * 1024];
            let mut oversized = false;
            loop {
                let count = stdout.read(&mut buffer).map_err(|_| ())?;
                if count == 0 {
                    break;
                }
                if collected.len().saturating_add(count) > MAX_REPLY_BYTES {
                    oversized = true;
                } else if !oversized {
                    collected.extend_from_slice(&buffer[..count]);
                }
            }
            if oversized {
                Err(())
            } else {
                Ok(collected)
            }
        });
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if started.elapsed() < INSPECTOR_TIMEOUT => {
                    thread::sleep(Duration::from_millis(10));
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
            }
        };
        let bytes = reader.join().ok().and_then(Result::ok);
        if status.is_none_or(|value| !value.success()) || bytes.is_none() {
            return InspectionOutcome::Unsupported;
        }
        let value: Value = match serde_json::from_slice(&bytes.unwrap()) {
            Ok(value) => value,
            Err(_) => return InspectionOutcome::Unsupported,
        };
        if value.get("supported").and_then(Value::as_bool) == Some(true) {
            InspectionOutcome::Supported(value)
        } else {
            InspectionOutcome::Unsupported
        }
    }
}

/// Content-addressed memo in front of another inspector.
///
/// One edit transaction inspects the same accepted bytes several times
/// (discovery, preflight, baseline capture). The inspection of a file is a pure
/// function of that file's bytes, so a result is reused only for byte-identical
/// content, keyed by its SHA-256. Unsupported outcomes are never cached, and a
/// changed file always produces a different key.
pub struct CachingInspector {
    inner: Box<dyn ResourceInspector>,
    entries: std::cell::RefCell<Vec<(String, Value)>>,
}

const CACHE_CAPACITY: usize = 4;

impl CachingInspector {
    pub fn new(inner: Box<dyn ResourceInspector>) -> Self {
        Self { inner, entries: std::cell::RefCell::new(Vec::new()) }
    }
}

impl ResourceInspector for CachingInspector {
    fn inspect(&self, source: &Path) -> InspectionOutcome {
        let key = match std::fs::File::open(source)
            .and_then(|mut file| crate::sha256_reader(&mut file))
        {
            Ok(key) => key,
            // If the content cannot be fingerprinted, do not cache at all.
            Err(_) => return self.inner.inspect(source),
        };
        if let Some((_, value)) = self.entries.borrow().iter().find(|(known, _)| *known == key) {
            return InspectionOutcome::Supported(value.clone());
        }
        match self.inner.inspect(source) {
            InspectionOutcome::Supported(value) => {
                let mut entries = self.entries.borrow_mut();
                if entries.len() >= CACHE_CAPACITY {
                    entries.remove(0);
                }
                entries.push((key, value.clone()));
                InspectionOutcome::Supported(value)
            }
            other => other,
        }
    }
}

pub struct UnavailableResourceInspector;

impl ResourceInspector for UnavailableResourceInspector {
    fn inspect(&self, _source: &Path) -> InspectionOutcome {
        InspectionOutcome::Unsupported
    }
}

pub struct TestResourceInspector;

impl ResourceInspector for TestResourceInspector {
    fn inspect(&self, _source: &Path) -> InspectionOutcome {
        InspectionOutcome::Supported(serde_json::json!({
            "supported": true,
            "schemaVersion": "edit-content-resource-inspection/v1",
            "pages": [],
        }))
    }
}

#[cfg(test)]
mod caching_tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    struct Counting {
        calls: Arc<AtomicU32>,
        supported: bool,
    }
    impl ResourceInspector for Counting {
        fn inspect(&self, source: &Path) -> InspectionOutcome {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.supported {
                InspectionOutcome::Supported(serde_json::json!({
                    "supported": true,
                    "bytes": std::fs::read(source).unwrap().len(),
                }))
            } else {
                InspectionOutcome::Unsupported
            }
        }
    }

    fn temp(name: &str, bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("cache-{}-{name}", std::process::id()));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn identical_bytes_are_inspected_once_regardless_of_path() {
        let calls = Arc::new(AtomicU32::new(0));
        let cache = CachingInspector::new(Box::new(Counting { calls: calls.clone(), supported: true }));
        let (a, b) = (temp("a.pdf", b"same"), temp("b.pdf", b"same"));
        assert!(matches!(cache.inspect(&a), InspectionOutcome::Supported(_)));
        assert!(matches!(cache.inspect(&a), InspectionOutcome::Supported(_)));
        assert!(matches!(cache.inspect(&b), InspectionOutcome::Supported(_)));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn changed_bytes_and_unsupported_results_are_never_served_from_cache() {
        let calls = Arc::new(AtomicU32::new(0));
        let cache = CachingInspector::new(Box::new(Counting { calls: calls.clone(), supported: true }));
        let path = temp("c.pdf", b"one");
        let first = cache.inspect(&path);
        std::fs::write(&path, b"three").unwrap();
        let second = cache.inspect(&path);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        match (first, second) {
            (InspectionOutcome::Supported(x), InspectionOutcome::Supported(y)) => assert_ne!(x, y),
            _ => panic!("both inspections must be supported"),
        }
        let failing_calls = Arc::new(AtomicU32::new(0));
        let failing = CachingInspector::new(Box::new(Counting { calls: failing_calls.clone(), supported: false }));
        assert!(matches!(failing.inspect(&path), InspectionOutcome::Unsupported));
        assert!(matches!(failing.inspect(&path), InspectionOutcome::Unsupported));
        assert_eq!(failing_calls.load(Ordering::SeqCst), 2);
    }
}
