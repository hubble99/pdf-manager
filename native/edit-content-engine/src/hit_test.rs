use crate::identity::{ObjectRegistry, ResolveError, TargetRecord};
use crate::viewport::{Point, Quad};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HitTestOutcome {
    None {
        mutation_command_created: bool,
    },
    Selected {
        target_id: String,
        mutation_command_created: bool,
    },
    ViewOnly {
        target_id: String,
        reason: String,
        mutation_command_created: bool,
    },
    Ambiguous {
        candidate_target_ids: Vec<String>,
        mutation_command_created: bool,
    },
    Stale {
        reason: String,
        mutation_command_created: bool,
    },
}

pub fn contains_point(quad: Quad, point: Point, tolerance: f32) -> bool {
    let mut sign = 0_i8;
    for index in 0..4 {
        let a = quad.points[index];
        let b = quad.points[(index + 1) % 4];
        let cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
        if cross.abs() <= tolerance {
            continue;
        }
        let current = if cross > 0.0 { 1 } else { -1 };
        if sign != 0 && sign != current {
            return false;
        }
        sign = current;
    }
    true
}

pub fn hit_test(
    registry: &ObjectRegistry,
    revision: u64,
    page_index: u16,
    point: Point,
    candidate_target_id: Option<&str>,
) -> HitTestOutcome {
    if let Some(target_id) = candidate_target_id {
        match registry.resolve(revision, target_id) {
            Ok(record) if record.page_index == page_index => {}
            Ok(_) | Err(ResolveError::ExpiredTarget | ResolveError::LegacyDescriptor) => {
                return HitTestOutcome::Stale {
                    reason: "REJECTED_STALE_TARGET".into(),
                    mutation_command_created: false,
                }
            }
            Err(ResolveError::StaleRevision) => {
                return HitTestOutcome::Stale {
                    reason: "REJECTED_STALE_REVISION".into(),
                    mutation_command_created: false,
                }
            }
        }
    }
    let records = match registry.records_on_page(revision, page_index) {
        Ok(records) => records,
        Err(ResolveError::StaleRevision) => {
            return HitTestOutcome::Stale {
                reason: "REJECTED_STALE_REVISION".into(),
                mutation_command_created: false,
            }
        }
        Err(_) => unreachable!(),
    };
    let mut matches: Vec<&TargetRecord> = records
        .into_iter()
        .filter(|record| contains_point(record.quad, point, 0.01))
        .collect();
    matches.sort_by(|left, right| left.target_id.cmp(&right.target_id));
    match matches.as_slice() {
        [] => HitTestOutcome::None {
            mutation_command_created: false,
        },
        [record] if record.editable => HitTestOutcome::Selected {
            target_id: record.target_id.clone(),
            mutation_command_created: false,
        },
        [record] => HitTestOutcome::ViewOnly {
            target_id: record.target_id.clone(),
            reason: record
                .view_only_reason
                .clone()
                .unwrap_or_else(|| "REJECTED_UNSUPPORTED_STRUCTURE".into()),
            mutation_command_created: false,
        },
        records => HitTestOutcome::Ambiguous {
            candidate_target_ids: records
                .iter()
                .map(|record| record.target_id.clone())
                .collect(),
            mutation_command_created: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::ObjectRegistry;

    fn quad(left: f32, right: f32) -> Quad {
        Quad {
            points: [
                Point { x: left, y: 0.0 },
                Point { x: right, y: 0.0 },
                Point { x: right, y: 10.0 },
                Point { x: left, y: 10.0 },
            ],
        }
    }

    #[test]
    fn adjacent_runs_and_whitespace_use_native_quads() {
        let mut registry = ObjectRegistry::new("s");
        registry.begin_snapshot(2);
        let first = registry.register(0, vec![0], "a b".into(), quad(0.0, 10.0), true, None);
        let second = registry.register(0, vec![1], "c".into(), quad(11.0, 20.0), true, None);
        assert_eq!(
            hit_test(&registry, 2, 0, Point { x: 5.0, y: 5.0 }, None),
            HitTestOutcome::Selected {
                target_id: first.target_id,
                mutation_command_created: false
            }
        );
        assert_eq!(
            hit_test(&registry, 2, 0, Point { x: 15.0, y: 5.0 }, None),
            HitTestOutcome::Selected {
                target_id: second.target_id,
                mutation_command_created: false
            }
        );
        assert!(matches!(
            hit_test(&registry, 2, 0, Point { x: 10.5, y: 5.0 }, None),
            HitTestOutcome::None { .. }
        ));
    }

    #[test]
    fn overlap_is_ambiguous_and_stale_metadata_never_retargets() {
        let mut registry = ObjectRegistry::new("s");
        registry.begin_snapshot(2);
        registry.register(0, vec![0], "first".into(), quad(0.0, 10.0), true, None);
        registry.register(0, vec![1], "second".into(), quad(0.0, 10.0), true, None);
        let old = registry.register(0, vec![2], "old".into(), quad(20.0, 30.0), true, None);
        assert!(matches!(
            hit_test(&registry, 2, 0, Point { x: 5.0, y: 5.0 }, None),
            HitTestOutcome::Ambiguous { .. }
        ));
        assert!(matches!(
            hit_test(&registry, 1, 0, Point { x: 5.0, y: 5.0 }, None),
            HitTestOutcome::Stale { .. }
        ));
        registry.begin_snapshot(2);
        registry.register(0, vec![2], "new".into(), quad(20.0, 30.0), true, None);
        assert!(matches!(
            hit_test(
                &registry,
                2,
                0,
                Point { x: 25.0, y: 5.0 },
                Some(&old.target_id)
            ),
            HitTestOutcome::Stale { .. }
        ));
    }

    #[test]
    fn unsupported_target_is_view_only_and_never_creates_mutation() {
        let mut registry = ObjectRegistry::new("s");
        registry.begin_snapshot(2);
        registry.register(
            0,
            vec![0],
            "nested".into(),
            quad(0.0, 10.0),
            false,
            Some("REJECTED_UNSUPPORTED_STRUCTURE".into()),
        );
        assert!(matches!(
            hit_test(&registry, 2, 0, Point { x: 5.0, y: 5.0 }, None),
            HitTestOutcome::ViewOnly {
                mutation_command_created: false,
                ..
            }
        ));
    }
}
