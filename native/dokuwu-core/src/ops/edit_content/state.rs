//! Pure preparation contracts for the session's single commit.
//!
//! Nothing here accepts a worker reply as a committed outcome or writes state.
//! A [`PreparedTransition`] becomes visible only after the store has verified
//! and installed its files and atomically switched the commit record.
//!
//! The field names are the record's JSON names (`edit-content-commit-record/v1`).

use serde::{Deserialize, Serialize};

use super::{identity, EditError};

/// The refusal of a request that names an older revision than the accepted one.
pub const STALE_REVISION_MESSAGE: &str = "stale accepted revision";
pub const MAX_CHECKPOINT_BYTES: i64 = 16 * 1024 * 1024;
pub const MAX_HISTORY_BYTES: i64 = 128 * 1024 * 1024;
pub const MAX_HISTORY_ENTRIES: usize = 8;
pub const VERIFIER_POLICY: &str = "edit-content-acceptance/v4";
pub const REQUIRED_CHECKS: [&str; 8] = [
    "target",
    "occurrences",
    "unique-correspondence",
    "font-identity",
    "geometry-style",
    "census",
    "resources",
    "layout",
];

fn rejected<T>(reason: &str) -> Result<T, EditError> {
    Err(EditError::Rejected(reason.to_owned()))
}

pub(crate) fn check_hash(value: &str) -> Result<(), EditError> {
    if value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        Ok(())
    } else {
        rejected("invalid artifact identity")
    }
}

pub(crate) fn check_id(value: &str) -> Result<(), EditError> {
    if (1..=128).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        Ok(())
    } else {
        rejected("invalid opaque identity")
    }
}

fn scalar_len(text: &str) -> usize {
    text.chars().count()
}

fn scalar_prefix(text: &str, count: usize) -> &str {
    let end = text.char_indices().nth(count).map_or(text.len(), |(index, _)| index);
    &text[..end]
}

fn scalar_suffix(text: &str, from: usize) -> &str {
    let start = text.char_indices().nth(from).map_or(text.len(), |(index, _)| index);
    &text[start..]
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditMetadata {
    pub request_id: String,
    pub operation: String,
    pub page_index: i64,
    pub source_scope: Vec<i64>,
    pub scalar_start: i64,
    pub scalar_end: i64,
    pub before_text: String,
    pub after_text: String,
    pub occurrence_before: i64,
    pub occurrence_after: i64,
    pub object_delta: i64,
    pub baseline_hash: String,
    pub engine_sha256: String,
    pub engine_build: String,
    pub wrapper: String,
    pub verifier_policy: String,
    pub checks: Vec<String>,
}

impl EditMetadata {
    pub fn validate(&self) -> Result<(), EditError> {
        check_id(&self.request_id)?;
        check_hash(&self.baseline_hash)?;
        if !matches!(self.operation.as_str(), "apply" | "save-with-draft") {
            return rejected("invalid edit operation");
        }
        if !(0..256).contains(&self.page_index) || self.source_scope.len() != 1 || self.source_scope[0] < 0 {
            return rejected("invalid target scope");
        }
        let before_len = scalar_len(&self.before_text) as i64;
        if !(0 <= self.scalar_start && self.scalar_start < self.scalar_end && self.scalar_end <= before_len) {
            return rejected("invalid scalar selection");
        }
        let prefix = scalar_prefix(&self.before_text, self.scalar_start as usize);
        let suffix = scalar_suffix(&self.before_text, self.scalar_end as usize);
        if scalar_len(&self.after_text) < scalar_len(prefix) + scalar_len(suffix)
            || !self.after_text.starts_with(prefix)
            || !self.after_text.ends_with(suffix)
        {
            return rejected("invalid target expectation");
        }
        let expected_delta = if self.after_text.is_empty() { -1 } else { 0 };
        if self.occurrence_before.min(self.occurrence_after) < 0 || self.object_delta != expected_delta {
            return rejected("invalid planned counts");
        }
        let (sha, build, wrapper) = match identity::current() {
            Ok(identity) => identity.verification_identity(),
            Err(_) => return rejected("verification identity is unavailable"),
        };
        let mut checks: Vec<&str> = self.checks.iter().map(String::as_str).collect();
        checks.sort_unstable();
        checks.dedup();
        let mut required = REQUIRED_CHECKS.to_vec();
        required.sort_unstable();
        if self.engine_sha256 != sha
            || self.engine_build != build
            || self.wrapper != wrapper
            || self.verifier_policy != VERIFIER_POLICY
            || checks != required
            || self.checks.len() != REQUIRED_CHECKS.len()
        {
            return rejected("missing verification identity");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub checkpoint_id: String,
    pub accepted_revision: i64,
    pub parent_accepted_revision: Option<i64>,
    pub parent_checkpoint_id: Option<String>,
    pub source_hash: String,
    pub accepted_artifact_hash: String,
    pub byte_size: i64,
    pub object_census: Vec<i64>,
    pub edit: Option<EditMetadata>,
}

impl Checkpoint {
    pub fn validate(&self) -> Result<(), EditError> {
        check_id(&self.checkpoint_id)?;
        check_hash(&self.source_hash)?;
        check_hash(&self.accepted_artifact_hash)?;
        if !(0 < self.byte_size && self.byte_size <= MAX_CHECKPOINT_BYTES) {
            return rejected("checkpoint exceeds the byte limit");
        }
        if !(1..=256).contains(&self.object_census.len()) || self.object_census.iter().any(|&c| c < 0) {
            return rejected("invalid object census");
        }
        match &self.edit {
            None => {
                if self.accepted_revision != 0
                    || self.parent_accepted_revision.is_some()
                    || self.parent_checkpoint_id.is_some()
                    || self.accepted_artifact_hash != self.source_hash
                {
                    return rejected("invalid source checkpoint");
                }
            }
            Some(edit) => {
                edit.validate()?;
                match &self.parent_checkpoint_id {
                    Some(parent) => check_id(parent)?,
                    None => return rejected("invalid opaque identity"),
                }
                match self.parent_accepted_revision {
                    Some(parent) if self.accepted_revision == parent + 1 => {}
                    _ => return rejected("invalid checkpoint creation revision"),
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Publication {
    pub output_id: String,
    pub artifact_hash: String,
    pub byte_size: i64,
}

impl Publication {
    pub fn validate(&self) -> Result<(), EditError> {
        check_id(&self.output_id)?;
        check_hash(&self.artifact_hash)?;
        if !(0 < self.byte_size && self.byte_size <= MAX_CHECKPOINT_BYTES) {
            return rejected("output exceeds the byte limit");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Outcome {
    pub request_id: String,
    pub revision: i64,
    pub checkpoint_id: String,
    pub output_id: Option<String>,
    pub clear_draft: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionState {
    pub session_id: String,
    pub source: Checkpoint,
    pub revision: i64,
    pub checkpoints: Vec<Checkpoint>,
    pub cursor: usize,
    pub saved_hash: String,
    pub last_output_id: Option<String>,
    pub publications: Vec<Publication>,
    pub outcomes: Vec<Outcome>,
}

impl SessionState {
    pub fn initial(session_id: &str, source: Checkpoint) -> Result<Self, EditError> {
        let state = Self {
            session_id: session_id.to_owned(),
            saved_hash: source.source_hash.clone(),
            checkpoints: vec![source.clone()],
            source,
            revision: 0,
            cursor: 0,
            last_output_id: None,
            publications: Vec::new(),
            outcomes: Vec::new(),
        };
        state.validate()?;
        Ok(state)
    }

    pub fn current(&self) -> &Checkpoint {
        &self.checkpoints[self.cursor]
    }

    pub fn dirty(&self, pending_draft: bool) -> bool {
        pending_draft || self.current().accepted_artifact_hash != self.saved_hash
    }

    pub fn known_outcome(&self, request_id: &str) -> Option<&Outcome> {
        self.outcomes.iter().find(|outcome| outcome.request_id == request_id)
    }

    pub fn validate(&self) -> Result<(), EditError> {
        check_id(&self.session_id)?;
        self.source.validate()?;
        check_hash(&self.saved_hash)?;
        if self.source.edit.is_some()
            || self.cursor >= self.checkpoints.len()
            || self.checkpoints.len() > MAX_HISTORY_ENTRIES
        {
            return rejected("invalid history state");
        }
        if self.revision < 0 || self.checkpoints.iter().map(|c| c.byte_size).sum::<i64>() > MAX_HISTORY_BYTES {
            return rejected("history exceeds its budget");
        }
        let mut identities = std::collections::HashSet::new();
        for checkpoint in &self.checkpoints {
            checkpoint.validate()?;
            if checkpoint.source_hash != self.source.source_hash
                || !identities.insert(checkpoint.checkpoint_id.as_str())
                || checkpoint.accepted_revision > self.revision
            {
                return rejected("invalid checkpoint identity");
            }
            if checkpoint.checkpoint_id == self.source.checkpoint_id && *checkpoint != self.source {
                return rejected("source checkpoint changed");
            }
        }
        let mut publications = std::collections::HashMap::new();
        for publication in &self.publications {
            publication.validate()?;
            if publications.insert(publication.output_id.as_str(), publication).is_some() {
                return rejected("duplicate publication identity");
            }
        }
        match &self.last_output_id {
            None => {
                if self.saved_hash != self.source.source_hash {
                    return rejected("invalid saved marker");
                }
            }
            Some(id) => match publications.get(id.as_str()) {
                Some(publication) if publication.artifact_hash == self.saved_hash => {}
                _ => return rejected("invalid saved publication"),
            },
        }
        let mut seen = std::collections::HashSet::new();
        if !self.outcomes.iter().all(|outcome| seen.insert(outcome.request_id.as_str())) {
            return rejected("duplicate request outcome");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedTransition {
    pub expected_revision: i64,
    pub baseline_hash: String,
    pub next_state: SessionState,
    pub outcome: Outcome,
    pub evicted_checkpoint_ids: Vec<String>,
}

pub struct TransitionRequest<'a> {
    pub request_id: &'a str,
    pub expected_revision: i64,
    pub operation: &'a str,
    pub pending_draft: bool,
    pub checkpoint: Option<&'a Checkpoint>,
    pub publication: Option<&'a Publication>,
}

/// Plans references only. No eviction, draft clearing or accepted reply yet.
pub fn prepare_transition(state: &SessionState, request: &TransitionRequest<'_>) -> Result<PreparedTransition, EditError> {
    state.validate()?;
    check_id(request.request_id)?;
    if state.known_outcome(request.request_id).is_some() {
        return rejected("return the recorded outcome without replay");
    }
    if request.expected_revision != state.revision {
        return rejected(STALE_REVISION_MESSAGE);
    }
    let mut history = state.checkpoints.clone();
    let mut cursor = state.cursor;
    let mut revision = state.revision;
    let mut evicted: Vec<String> = Vec::new();
    let operation = request.operation;
    let editing = matches!(operation, "apply" | "save-with-draft");
    let publishing = matches!(operation, "save-with-draft" | "save");
    if !matches!(operation, "apply" | "save-with-draft" | "save" | "undo" | "redo") {
        return rejected("unknown operation");
    }
    if editing != request.checkpoint.is_some() || publishing != request.publication.is_some() {
        return rejected("incomplete preparation");
    }
    if request.pending_draft != editing {
        return rejected("apply or explicitly discard the draft first");
    }
    if let Some(checkpoint) = request.checkpoint {
        checkpoint.validate()?;
        let edit = match &checkpoint.edit {
            Some(edit) => edit,
            None => return rejected("candidate is not bound to the current checkpoint"),
        };
        if edit.request_id != request.request_id
            || edit.operation != operation
            || checkpoint.source_hash != state.source.source_hash
            || checkpoint.parent_checkpoint_id.as_deref() != Some(state.current().checkpoint_id.as_str())
            || checkpoint.parent_accepted_revision != Some(revision)
            || checkpoint.accepted_revision != revision + 1
            || edit.baseline_hash != state.current().accepted_artifact_hash
            || history.iter().any(|item| item.checkpoint_id == checkpoint.checkpoint_id)
        {
            return rejected("candidate is not bound to the current checkpoint");
        }
        let mut expected_census = state.current().object_census.clone();
        let page = edit.page_index as usize;
        if page >= expected_census.len() {
            return rejected("target page is absent");
        }
        expected_census[page] += edit.object_delta;
        if expected_census != checkpoint.object_census {
            return rejected("candidate census differs from the planned target delta");
        }
        evicted.extend(history[cursor + 1..].iter().map(|item| item.checkpoint_id.clone()));
        history.truncate(cursor + 1);
        history.push(checkpoint.clone());
        revision += 1;
        while history.len() > MAX_HISTORY_ENTRIES || history.iter().map(|c| c.byte_size).sum::<i64>() > MAX_HISTORY_BYTES {
            let last = history.len() - 1;
            let eligible = history[..last].iter().position(|item| item.checkpoint_id != state.source.checkpoint_id);
            match eligible {
                Some(index) => evicted.push(history.remove(index).checkpoint_id),
                None => return rejected("insufficient history budget"),
            }
        }
        cursor = history.len() - 1;
    } else if matches!(operation, "undo" | "redo") {
        if operation == "undo" {
            if cursor == 0 {
                return rejected("history boundary");
            }
            cursor -= 1;
        } else {
            cursor += 1;
            if cursor >= history.len() {
                return rejected("history boundary");
            }
        }
        revision += 1;
    }
    let mut saved_hash = state.saved_hash.clone();
    let mut last_output_id = state.last_output_id.clone();
    let mut publications = state.publications.clone();
    if let Some(publication) = request.publication {
        publication.validate()?;
        let current = &history[cursor];
        if publication.artifact_hash != current.accepted_artifact_hash
            || publication.byte_size != current.byte_size
            || publications.iter().any(|item| item.output_id == publication.output_id)
        {
            return rejected("publication does not identify exact accepted bytes");
        }
        publications.push(publication.clone());
        saved_hash = publication.artifact_hash.clone();
        last_output_id = Some(publication.output_id.clone());
    }
    let outcome = Outcome {
        request_id: request.request_id.to_owned(),
        revision,
        checkpoint_id: history[cursor].checkpoint_id.clone(),
        output_id: if publishing { last_output_id.clone() } else { None },
        clear_draft: editing,
    };
    let mut outcomes = state.outcomes.clone();
    outcomes.push(outcome.clone());
    let prepared = SessionState {
        session_id: state.session_id.clone(),
        source: state.source.clone(),
        revision,
        checkpoints: history,
        cursor,
        saved_hash,
        last_output_id,
        publications,
        outcomes,
    };
    prepared.validate()?;
    Ok(PreparedTransition {
        expected_revision: state.revision,
        baseline_hash: state.current().accepted_artifact_hash.clone(),
        next_state: prepared,
        outcome,
        evicted_checkpoint_ids: evicted.into_iter().filter(|id| *id != state.source.checkpoint_id).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine_sha() -> String {
        identity::current().unwrap().library_sha256.clone()
    }

    fn initial() -> SessionState {
        let hash = "0".repeat(64);
        SessionState::initial(
            "session",
            Checkpoint {
                checkpoint_id: "source".into(),
                accepted_revision: 0,
                parent_accepted_revision: None,
                parent_checkpoint_id: None,
                source_hash: hash.clone(),
                accepted_artifact_hash: hash,
                byte_size: 500,
                object_census: vec![2, 3],
                edit: None,
            },
        )
        .unwrap()
    }

    fn edit(state: &SessionState, request_id: &str, operation: &str, artifact_hash: &str) -> Checkpoint {
        let (_, build, wrapper) = identity::current().unwrap().verification_identity();
        Checkpoint {
            checkpoint_id: format!("checkpoint_{request_id}"),
            accepted_revision: state.revision + 1,
            parent_accepted_revision: Some(state.revision),
            parent_checkpoint_id: Some(state.current().checkpoint_id.clone()),
            source_hash: state.source.source_hash.clone(),
            accepted_artifact_hash: artifact_hash.into(),
            byte_size: 600,
            object_census: state.current().object_census.clone(),
            edit: Some(EditMetadata {
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
                engine_sha256: engine_sha(),
                engine_build: build,
                wrapper,
                verifier_policy: VERIFIER_POLICY.into(),
                checks: REQUIRED_CHECKS.iter().map(|c| c.to_string()).collect(),
            }),
        }
    }

    fn apply_with(state: &SessionState, request_id: &str, hash: &str) -> Result<PreparedTransition, EditError> {
        let checkpoint = edit(state, request_id, "apply", hash);
        prepare_transition(
            state,
            &TransitionRequest {
                request_id,
                expected_revision: state.revision,
                operation: "apply",
                pending_draft: true,
                checkpoint: Some(&checkpoint),
                publication: None,
            },
        )
    }

    fn apply(state: &SessionState, request_id: &str) -> PreparedTransition {
        apply_with(state, request_id, &"1".repeat(64)).unwrap()
    }

    fn plain(state: &SessionState, request_id: &str, operation: &str, publication: Option<&Publication>) -> Result<PreparedTransition, EditError> {
        prepare_transition(
            state,
            &TransitionRequest {
                request_id,
                expected_revision: state.revision,
                operation,
                pending_draft: false,
                checkpoint: None,
                publication,
            },
        )
    }

    fn is_rejected<T>(result: Result<T, EditError>) -> bool {
        matches!(result, Err(EditError::Rejected(_)))
    }

    #[test]
    fn a_prepared_transition_is_not_accepted_and_a_failed_save_changes_nothing() {
        let state = initial();
        let prepared = apply(&state, "edit1");
        assert!(state.revision == 0 && state.checkpoints.len() == 1);
        assert!(state.known_outcome("edit1").is_none());
        assert!(!state.dirty(false));
        assert!(prepared.next_state.dirty(false));
        assert!(prepared.outcome.clear_draft);
        let committed = prepared.next_state;
        let stray = Publication { output_id: "out".into(), artifact_hash: "9".repeat(64), byte_size: 600 };
        let mut request = TransitionRequest {
            request_id: "save1",
            expected_revision: 1,
            operation: "save",
            pending_draft: false,
            checkpoint: None,
            publication: Some(&stray),
        };
        assert!(is_rejected(prepare_transition(&committed, &request)));
        request.operation = "undo";
        request.publication = None;
        assert_eq!(prepare_transition(&committed, &request).unwrap().next_state.cursor, 0);
        assert_eq!(committed.saved_hash, state.saved_hash);
        assert!(committed.publications.is_empty());
    }

    #[test]
    fn save_with_draft_is_joint_and_an_unchanged_save_reuses_the_checkpoint() {
        let state = initial();
        let checkpoint = edit(&state, "edit1", "save-with-draft", &"1".repeat(64));
        let publication = Publication { output_id: "out1".into(), artifact_hash: checkpoint.accepted_artifact_hash.clone(), byte_size: checkpoint.byte_size };
        let prepared = prepare_transition(
            &state,
            &TransitionRequest {
                request_id: "edit1",
                expected_revision: 0,
                operation: "save-with-draft",
                pending_draft: true,
                checkpoint: Some(&checkpoint),
                publication: Some(&publication),
            },
        )
        .unwrap();
        assert!(state.publications.is_empty() && state.revision == 0);
        let committed = prepared.next_state;
        assert!(committed.revision == 1 && !committed.dirty(false));
        let second = Publication { output_id: "out2".into(), ..publication };
        let saved = plain(&committed, "save2", "save", Some(&second)).unwrap().next_state;
        assert_eq!(saved.current(), committed.current());
        assert!(saved.checkpoints == committed.checkpoints && saved.revision == 1);
        assert_eq!(saved.publications.len(), 2);
        assert!(!saved.outcomes.last().unwrap().clear_draft);
    }

    #[test]
    fn undo_redo_revisions_dirty_and_pending_draft_are_independent() {
        let state = apply(&initial(), "edit1").next_state;
        let publication = Publication { output_id: "out".into(), artifact_hash: state.current().accepted_artifact_hash.clone(), byte_size: 600 };
        let saved = plain(&state, "save", "save", Some(&publication)).unwrap().next_state;
        for operation in ["undo", "redo", "save"] {
            let request = TransitionRequest {
                request_id: "pending",
                expected_revision: 1,
                operation,
                pending_draft: true,
                checkpoint: None,
                publication: None,
            };
            assert!(is_rejected(prepare_transition(&saved, &request)), "{operation}");
        }
        let undone = plain(&saved, "undo", "undo", None).unwrap().next_state;
        assert!(undone.current().accepted_revision == 0 && undone.revision == 2);
        assert!(undone.dirty(false));
        assert_eq!(undone.publications, saved.publications);
        let redone = plain(&undone, "redo", "redo", None).unwrap().next_state;
        assert!(redone.current().accepted_revision == 1 && redone.revision == 3);
        assert!(!redone.dirty(false));
        assert!(redone.dirty(true));
        let stale = TransitionRequest { request_id: "stale", expected_revision: 1, operation: "undo", pending_draft: false, checkpoint: None, publication: None };
        assert!(is_rejected(prepare_transition(&redone, &stale)));
        assert!(is_rejected(plain(&state, "boundary", "redo", None)));
    }

    #[test]
    fn redo_truncation_and_budget_eviction_exist_only_in_the_prepared_state() {
        let mut state = initial();
        for index in 1..10 {
            state = apply_with(&state, &format!("edit{index}"), &format!("{index:064x}")).unwrap().next_state;
        }
        assert!(state.checkpoints.len() == 8 && state.checkpoints[0] == state.source);
        assert_eq!(state.checkpoints[1].edit.as_ref().unwrap().request_id, "edit3");
        let undone = plain(&state, "undo", "undo", None).unwrap().next_state;
        let prepared = apply_with(&undone, "branch", &"a".repeat(64)).unwrap();
        assert_eq!(undone.checkpoints.last().unwrap().edit.as_ref().unwrap().request_id, "edit9");
        assert_eq!(prepared.next_state.checkpoints.last().unwrap().edit.as_ref().unwrap().request_id, "branch");
        assert_eq!(prepared.evicted_checkpoint_ids, vec!["checkpoint_edit9".to_string()]);
        assert_eq!(prepared.next_state.source, state.source);
    }

    #[test]
    fn invalid_evidence_oversize_census_and_duplicates_never_prepare() {
        let state = initial();
        let good = edit(&state, "edit1", "apply", &"1".repeat(64));
        let mut invalid = Vec::new();
        invalid.push(Checkpoint { byte_size: MAX_CHECKPOINT_BYTES + 1, ..good.clone() });
        invalid.push(Checkpoint { object_census: vec![2, 4], ..good.clone() });
        for change in [
            |e: &mut EditMetadata| e.checks.clear(),
            |e: &mut EditMetadata| e.engine_sha256 = "b".repeat(64),
            |e: &mut EditMetadata| e.baseline_hash = "b".repeat(64),
            |e: &mut EditMetadata| e.checks = vec!["target".into(); 8],
            |e: &mut EditMetadata| e.scalar_end = 99,
            |e: &mut EditMetadata| e.scalar_start = 1,
            |e: &mut EditMetadata| e.object_delta = 1,
            |e: &mut EditMetadata| e.verifier_policy = "edit-content-acceptance/v3".into(),
        ] {
            let mut copy = good.clone();
            change(copy.edit.as_mut().unwrap());
            invalid.push(copy);
        }
        for value in &invalid {
            let request = TransitionRequest { request_id: "edit1", expected_revision: 0, operation: "apply", pending_draft: true, checkpoint: Some(value), publication: None };
            assert!(is_rejected(prepare_transition(&state, &request)));
            assert_eq!(state.current(), &state.source);
        }
        let committed = apply(&state, "edit1").next_state;
        assert_eq!(committed.known_outcome("edit1").unwrap().revision, 1);
        let again = apply_with(&committed, "edit1", &"2".repeat(64));
        assert!(matches!(&again, Err(EditError::Rejected(m)) if m.contains("without replay")));
    }

    #[test]
    fn identities_and_hashes_are_checked() {
        assert!(check_id("a-b_C9").is_ok());
        for bad in ["", "a b", "../x", &"a".repeat(129)] {
            assert!(check_id(bad).is_err(), "{bad:?}");
        }
        assert!(check_hash(&"a".repeat(64)).is_ok());
        assert!(check_hash(&"A".repeat(64)).is_err());
        assert!(check_hash("abc").is_err());
    }

    #[test]
    fn scalar_positions_count_code_points_not_bytes() {
        let state = initial();
        let mut checkpoint = edit(&state, "edit1", "apply", &"1".repeat(64));
        let metadata = checkpoint.edit.as_mut().unwrap();
        metadata.before_text = "né€w".into();
        metadata.after_text = "néXw".into();
        metadata.scalar_start = 2;
        metadata.scalar_end = 3;
        checkpoint.validate().unwrap();
        checkpoint.edit.as_mut().unwrap().scalar_end = 5;
        assert!(checkpoint.validate().is_err());
    }
}
