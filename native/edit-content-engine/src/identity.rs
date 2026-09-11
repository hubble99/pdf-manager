use crate::sha256_reader;
use crate::viewport::Quad;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static REGISTRY_INSTANCE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetRecord {
    pub target_id: String,
    pub native_object_identity: String,
    pub page_index: u16,
    pub object_path: Vec<usize>,
    pub text: String,
    pub quad: Quad,
    pub editable: bool,
    pub view_only_reason: Option<String>,
    pub evidence: TargetEvidence,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetEvidence {
    pub font_resource_object: Option<String>,
    pub font_subtype: Option<String>,
    pub glyph_coverage: Option<serde_json::Value>,
    pub source_scope_kind: String,
    pub render_mode: String,
}

impl Default for TargetEvidence {
    fn default() -> Self {
        Self {
            font_resource_object: None,
            font_subtype: None,
            glyph_coverage: None,
            source_scope_kind: "page".into(),
            render_mode: "FilledUnstroked".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    StaleRevision,
    ExpiredTarget,
    LegacyDescriptor,
}

pub struct ObjectRegistry {
    session_id: String,
    instance_nonce: String,
    revision: u64,
    epoch: u64,
    records: HashMap<String, TargetRecord>,
}

impl ObjectRegistry {
    pub fn new(session_id: impl Into<String>) -> Self {
        let nonce_seed = format!(
            "{}:{}:{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            REGISTRY_INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed),
        );
        Self {
            session_id: session_id.into(),
            instance_nonce: sha256_reader(&mut Cursor::new(nonce_seed.as_bytes())).unwrap(),
            revision: 0,
            epoch: 0,
            records: HashMap::new(),
        }
    }

    pub fn begin_snapshot(&mut self, revision: u64) {
        self.revision = revision;
        self.epoch = self.epoch.wrapping_add(1);
        self.records.clear();
    }

    pub fn register(
        &mut self,
        page_index: u16,
        object_path: Vec<usize>,
        text: String,
        quad: Quad,
        editable: bool,
        view_only_reason: Option<String>,
    ) -> TargetRecord {
        let seed = format!(
            "{}\0{}\0{}\0{}\0{}\0{:?}\0{}",
            self.session_id,
            self.instance_nonce,
            self.revision,
            self.epoch,
            page_index,
            object_path,
            text
        );
        let native_seed = format!("native\0{seed}");
        let target_hash = sha256_reader(&mut Cursor::new(seed.as_bytes())).unwrap();
        let native_hash = sha256_reader(&mut Cursor::new(native_seed.as_bytes())).unwrap();
        let record = TargetRecord {
            target_id: format!("target-{}", &target_hash[..32]),
            native_object_identity: format!("object-{}", &native_hash[..32]),
            page_index,
            object_path,
            text,
            quad,
            editable,
            view_only_reason,
            evidence: TargetEvidence::default(),
        };
        self.records
            .insert(record.target_id.clone(), record.clone());
        record
    }

    pub fn attach_evidence(&mut self, target_id: &str, evidence: TargetEvidence) {
        if let Some(record) = self.records.get_mut(target_id) {
            record.evidence = evidence;
        }
    }

    pub fn resolve(&self, revision: u64, target_id: &str) -> Result<&TargetRecord, ResolveError> {
        if revision != self.revision {
            return Err(ResolveError::StaleRevision);
        }
        if !target_id.starts_with("target-") {
            return Err(ResolveError::LegacyDescriptor);
        }
        self.records
            .get(target_id)
            .ok_or(ResolveError::ExpiredTarget)
    }

    pub fn records_on_page(
        &self,
        revision: u64,
        page_index: u16,
    ) -> Result<Vec<&TargetRecord>, ResolveError> {
        if revision != self.revision {
            return Err(ResolveError::StaleRevision);
        }
        Ok(self
            .records
            .values()
            .filter(|record| record.page_index == page_index)
            .collect())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnicodeRange {
    pub scalar_start: usize,
    pub scalar_end: usize,
}

pub fn utf16_range_to_scalar(
    text: &str,
    utf16_start: usize,
    utf16_end: usize,
) -> Result<UnicodeRange, &'static str> {
    if utf16_start > utf16_end {
        return Err("range start exceeds range end");
    }
    let mut utf16_offset = 0;
    let mut scalar_offset = 0;
    let mut scalar_start = None;
    let mut scalar_end = None;
    for character in text.chars() {
        if utf16_offset == utf16_start {
            scalar_start = Some(scalar_offset);
        }
        if utf16_offset == utf16_end {
            scalar_end = Some(scalar_offset);
        }
        utf16_offset += character.len_utf16();
        scalar_offset += 1;
        if utf16_offset > utf16_start && scalar_start.is_none() {
            return Err("range starts inside a UTF-16 surrogate pair");
        }
        if utf16_offset > utf16_end && scalar_end.is_none() {
            return Err("range ends inside a UTF-16 surrogate pair");
        }
    }
    if utf16_offset == utf16_start {
        scalar_start = Some(scalar_offset);
    }
    if utf16_offset == utf16_end {
        scalar_end = Some(scalar_offset);
    }
    match (scalar_start, scalar_end) {
        (Some(scalar_start), Some(scalar_end)) => Ok(UnicodeRange {
            scalar_start,
            scalar_end,
        }),
        _ => Err("range exceeds text length"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::viewport::{Point, Quad};

    fn quad() -> Quad {
        Quad {
            points: [
                Point { x: 0.0, y: 0.0 },
                Point { x: 10.0, y: 0.0 },
                Point { x: 10.0, y: 10.0 },
                Point { x: 0.0, y: 10.0 },
            ],
        }
    }

    #[test]
    fn duplicate_strings_keep_distinct_object_identity() {
        let mut registry = ObjectRegistry::new("session");
        registry.begin_snapshot(4);
        let first = registry.register(0, vec![1], "same".into(), quad(), true, None);
        let second = registry.register(0, vec![2], "same".into(), quad(), true, None);
        assert_ne!(first.target_id, second.target_id);
        assert_ne!(first.native_object_identity, second.native_object_identity);
    }

    #[test]
    fn refresh_and_reopen_expire_old_handles() {
        let mut registry = ObjectRegistry::new("session");
        registry.begin_snapshot(4);
        let old = registry.register(0, vec![1], "text".into(), quad(), true, None);
        registry.begin_snapshot(5);
        assert_eq!(
            registry.resolve(4, &old.target_id),
            Err(ResolveError::StaleRevision)
        );
        assert_eq!(
            registry.resolve(5, &old.target_id),
            Err(ResolveError::ExpiredTarget)
        );
        assert_eq!(
            registry.resolve(5, "page-0-object-1"),
            Err(ResolveError::LegacyDescriptor)
        );

        let mut reopened = ObjectRegistry::new("session");
        reopened.begin_snapshot(4);
        let after_reopen = reopened.register(0, vec![1], "text".into(), quad(), true, None);
        assert_ne!(old.target_id, after_reopen.target_id);
        assert_eq!(
            reopened.resolve(4, &old.target_id),
            Err(ResolveError::ExpiredTarget)
        );
    }

    #[test]
    fn converts_utf16_ranges_to_exact_unicode_scalar_ranges() {
        assert_eq!(
            utf16_range_to_scalar("A😀B", 1, 3).unwrap(),
            UnicodeRange {
                scalar_start: 1,
                scalar_end: 2
            }
        );
        assert!(utf16_range_to_scalar("A😀B", 2, 3).is_err());
        assert!(utf16_range_to_scalar("A😀B", 1, 2).is_err());
        assert!(utf16_range_to_scalar("A😀B", 0, 9).is_err());
    }
}
