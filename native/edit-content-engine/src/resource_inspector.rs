use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::MAX_REPLY_BYTES;

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

/// Inspection results that outlive this worker process.
///
/// A session restarts its worker after every commit and once while opening, and
/// a fresh worker would otherwise repeat the whole inspection of bytes it has
/// already seen. Entries are keyed by the SHA-256 of the inspected bytes plus a
/// build identity, only supported results are stored, and anything unreadable,
/// oversized or inconsistent is treated as a miss. The directory is private to
/// the session and removed by the host when the session ends.
pub struct DiskCachingInspector {
    inner: Box<dyn ResourceInspector>,
    directory: PathBuf,
    cache_id: String,
}

const DISK_CACHE_ENTRIES: usize = 8;

impl DiskCachingInspector {
    pub fn new(inner: Box<dyn ResourceInspector>, directory: PathBuf, cache_id: String) -> Self {
        Self { inner, directory, cache_id }
    }

    fn entry_path(&self, key: &str) -> Option<PathBuf> {
        // The key is a hex digest; refuse anything that could address another path.
        (key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .then(|| self.directory.join(format!("{key}.json")))
    }

    fn load(&self, key: &str) -> Option<Value> {
        let path = self.entry_path(key)?;
        let metadata = std::fs::symlink_metadata(&path).ok()?;
        if !metadata.is_file() || metadata.len() > MAX_REPLY_BYTES as u64 {
            return None;
        }
        let stored: Value = serde_json::from_slice(&std::fs::read(&path).ok()?).ok()?;
        let payload = stored.get("payload")?;
        (stored.get("cacheId")?.as_str()? == self.cache_id
            && stored.get("key")?.as_str()? == key
            && payload.get("supported").and_then(Value::as_bool) == Some(true))
        .then(|| payload.clone())
    }

    fn store(&self, key: &str, payload: &Value) {
        let Some(path) = self.entry_path(key) else { return };
        if std::fs::create_dir_all(&self.directory).is_err() {
            return;
        }
        let record = serde_json::json!({ "cacheId": self.cache_id, "key": key, "payload": payload });
        let Ok(bytes) = serde_json::to_vec(&record) else { return };
        if bytes.len() > MAX_REPLY_BYTES {
            return;
        }
        let temporary = self.directory.join(format!("{key}.{}.tmp", std::process::id()));
        if std::fs::write(&temporary, &bytes).is_err() || std::fs::rename(&temporary, &path).is_err() {
            let _ = std::fs::remove_file(&temporary);
            return;
        }
        self.prune();
    }

    fn prune(&self) {
        let Ok(listing) = std::fs::read_dir(&self.directory) else { return };
        let mut entries: Vec<_> = listing
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|extension| extension == "json"))
            .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
            .collect();
        if entries.len() <= DISK_CACHE_ENTRIES {
            return;
        }
        entries.sort();
        for (_, path) in &entries[..entries.len() - DISK_CACHE_ENTRIES] {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl ResourceInspector for DiskCachingInspector {
    fn inspect(&self, source: &Path) -> InspectionOutcome {
        let key = match std::fs::File::open(source)
            .and_then(|mut file| crate::sha256_reader(&mut file))
        {
            Ok(key) => key,
            Err(_) => return self.inner.inspect(source),
        };
        if let Some(payload) = self.load(&key) {
            return InspectionOutcome::Supported(payload);
        }
        match self.inner.inspect(source) {
            InspectionOutcome::Supported(payload) => {
                self.store(&key, &payload);
                InspectionOutcome::Supported(payload)
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

#[cfg(test)]
mod persistence_tests {
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
                    "from": "fallback",
                    "bytes": std::fs::read(source).unwrap().len(),
                }))
            } else {
                InspectionOutcome::Unsupported
            }
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("persist-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn file(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn counting(calls: &Arc<AtomicU32>, supported: bool) -> Box<dyn ResourceInspector> {
        Box::new(Counting { calls: calls.clone(), supported })
    }

    #[test]
    fn disk_cache_survives_a_new_worker_and_ignores_other_builds() {
        let dir = scratch("disk");
        let source = file(&dir, "a.pdf", b"same bytes");
        let cache = dir.join("cache");
        let calls = Arc::new(AtomicU32::new(0));
        let first = DiskCachingInspector::new(counting(&calls, true), cache.clone(), "build-1".into());
        assert!(matches!(first.inspect(&source), InspectionOutcome::Supported(_)));
        // A restarted worker is a new inspector object over the same directory.
        let second = DiskCachingInspector::new(counting(&calls, true), cache.clone(), "build-1".into());
        assert!(matches!(second.inspect(&source), InspectionOutcome::Supported(_)));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let other_build = DiskCachingInspector::new(counting(&calls, true), cache.clone(), "build-2".into());
        assert!(matches!(other_build.inspect(&source), InspectionOutcome::Supported(_)));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        std::fs::write(&source, b"different bytes").unwrap();
        assert!(matches!(second.inspect(&source), InspectionOutcome::Supported(_)));
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn disk_cache_never_stores_unsupported_and_rejects_damaged_entries() {
        let dir = scratch("damaged");
        let source = file(&dir, "a.pdf", b"bytes");
        let cache = dir.join("cache");
        let calls = Arc::new(AtomicU32::new(0));
        let refuse = DiskCachingInspector::new(counting(&calls, false), cache.clone(), "b".into());
        assert!(matches!(refuse.inspect(&source), InspectionOutcome::Unsupported));
        assert!(matches!(refuse.inspect(&source), InspectionOutcome::Unsupported));
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        let accept = DiskCachingInspector::new(counting(&calls, true), cache.clone(), "b".into());
        assert!(matches!(accept.inspect(&source), InspectionOutcome::Supported(_)));
        let entry = std::fs::read_dir(&cache).unwrap().next().unwrap().unwrap().path();
        for damage in [
            b"not json".to_vec(),
            serde_json::to_vec(&serde_json::json!({"cacheId": "b", "key": "0".repeat(64), "payload": {"supported": true}})).unwrap(),
            serde_json::to_vec(&serde_json::json!({"cacheId": "b", "key": "x", "payload": {"supported": false}})).unwrap(),
        ] {
            std::fs::write(&entry, damage).unwrap();
            let before = calls.load(Ordering::SeqCst);
            assert!(matches!(accept.inspect(&source), InspectionOutcome::Supported(_)));
            assert_eq!(calls.load(Ordering::SeqCst), before + 1, "a damaged entry must be recomputed");
        }
    }

    #[test]
    fn disk_cache_keeps_only_the_most_recent_entries() {
        let dir = scratch("prune");
        let cache = dir.join("cache");
        let calls = Arc::new(AtomicU32::new(0));
        let inspector = DiskCachingInspector::new(counting(&calls, true), cache.clone(), "b".into());
        for index in 0..(DISK_CACHE_ENTRIES + 3) {
            let source = file(&dir, "s.pdf", format!("content {index}").as_bytes());
            assert!(matches!(inspector.inspect(&source), InspectionOutcome::Supported(_)));
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        let kept = std::fs::read_dir(&cache).unwrap().count();
        assert_eq!(kept, DISK_CACHE_ENTRIES);
    }

}
