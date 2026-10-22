//! Natural ordering for file and folder names, the rule the Merge workspace
//! uses for its sources tree and for the first order of the merge queue.
//!
//! - letter case never decides the order (names are compared case-folded);
//! - runs of ASCII digits compare as numbers, so `report2.pdf` precedes
//!   `report10.pdf`, and leading zeros do not change a value;
//! - everything else compares by code point, so `apple.pdf` precedes
//!   `apple2.pdf` (`.` sorts before `2`);
//! - names equal under these rules fall back to their raw text, so the order
//!   is reproducible.
//!
//! The comparison walks the names character by character instead of comparing
//! chunks: chunk-wise, `apple2.pdf` would sort before `APPLE.pdf` because the
//! chunk `apple` is a prefix of `apple.pdf`.

use std::cmp::Ordering;

pub fn compare_names(left: &str, right: &str) -> Ordering {
    let l: Vec<char> = left.chars().collect();
    let r: Vec<char> = right.chars().collect();
    let (mut i, mut j) = (0, 0);
    while i < l.len() && j < r.len() {
        if l[i].is_ascii_digit() && r[j].is_ascii_digit() {
            let li = digit_run_end(&l, i);
            let ri = digit_run_end(&r, j);
            match compare_digit_runs(&l[i..li], &r[j..ri]) {
                Ordering::Equal => {
                    i = li;
                    j = ri;
                    continue;
                }
                other => return other,
            }
        }
        let lf = fold(l[i]);
        let rf = fold(r[j]);
        if lf != rf {
            return lf.cmp(&rf);
        }
        i += 1;
        j += 1;
    }
    if i == l.len() && j == r.len() {
        // Same under the rule (only leading zeros or letter case differ).
        return left.cmp(right);
    }
    if i == l.len() {
        Ordering::Less
    } else {
        Ordering::Greater
    }
}

pub fn natural_sorted<S: AsRef<str>>(names: impl IntoIterator<Item = S>) -> Vec<String> {
    let mut out: Vec<String> = names.into_iter().map(|s| s.as_ref().to_string()).collect();
    out.sort_by(|a, b| compare_names(a, b));
    out
}

/// End index of the digit run starting at `start`.
fn digit_run_end(chars: &[char], start: usize) -> usize {
    let mut end = start;
    while end < chars.len() && chars[end].is_ascii_digit() {
        end += 1;
    }
    end
}

/// Compares two digit runs as numbers of any length.
fn compare_digit_runs(a: &[char], b: &[char]) -> Ordering {
    let a = trim_zeros(a);
    let b = trim_zeros(b);
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

fn trim_zeros(run: &[char]) -> &[char] {
    let first = run.iter().position(|c| *c != '0').unwrap_or(run.len());
    &run[first..]
}

/// Simple case folding: enough for file names, and the same on every platform.
fn fold(c: char) -> char {
    let mut lower = c.to_lowercase();
    match (lower.next(), lower.next()) {
        (Some(only), None) => only,
        _ => c,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(names: &[&str]) -> Vec<String> {
        natural_sorted(names.iter().copied())
    }

    #[test]
    fn numbers_compare_by_value() {
        assert_eq!(sorted(&["report10.pdf", "report2.pdf", "report1.pdf"]), ["report1.pdf", "report2.pdf", "report10.pdf"]);
    }

    #[test]
    fn case_does_not_decide() {
        assert_eq!(sorted(&["b.pdf", "A.pdf", "a2.pdf"]), ["A.pdf", "a2.pdf", "b.pdf"]);
    }

    #[test]
    fn dot_sorts_before_digit_after_shared_prefix() {
        assert_eq!(sorted(&["apple2.pdf", "APPLE.pdf", "apple.pdf"]), ["APPLE.pdf", "apple.pdf", "apple2.pdf"]);
    }

    #[test]
    fn leading_zeros_do_not_change_value_but_keep_order_reproducible() {
        assert_eq!(compare_names("a01", "a1"), Ordering::Less);
        assert_eq!(compare_names("a1", "a01"), Ordering::Greater);
        assert_eq!(compare_names("a01", "a2"), Ordering::Less);
        assert_eq!(compare_names("a1", "a1"), Ordering::Equal);
    }

    #[test]
    fn very_long_digit_runs_do_not_overflow() {
        let big = "9".repeat(60);
        let bigger = format!("1{}", "0".repeat(60));
        assert_eq!(compare_names(&format!("x{big}"), &format!("x{bigger}")), Ordering::Less);
    }

    #[test]
    fn shorter_name_first() {
        assert_eq!(compare_names("a", "ab"), Ordering::Less);
        assert_eq!(compare_names("ab", "a"), Ordering::Greater);
    }
}
