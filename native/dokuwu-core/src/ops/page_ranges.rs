//! Page selections such as `1-3,5,7-9`.

use crate::error::{CoreError, CoreResult};

/// Parses `text` against a document of `total` pages and returns the pages it
/// names, 1-based, sorted and without duplicates. Blank text is an error; use
/// [`select`] to mean "all pages".
pub fn parse(text: &str, total: u32) -> CoreResult<Vec<u32>> {
    let mut pages: Vec<u32> = parse_groups(text, total)?.into_iter().flatten().collect();
    pages.sort_unstable();
    pages.dedup();
    Ok(pages)
}

/// Like [`parse`], but keeps what was typed: one group per comma-separated
/// token, in the order written, duplicates included. `"3, 1-2, 3"` gives
/// `[[3], [1, 2], [3]]`. Extract uses the groups to build one output per range.
pub fn parse_groups(text: &str, total: u32) -> CoreResult<Vec<Vec<u32>>> {
    if text.trim().is_empty() {
        return Err(CoreError::InvalidInput("page range string is empty".into()));
    }
    let mut groups = Vec::new();
    for token in text.split(',').map(str::trim).filter(|t| !t.is_empty()) {
        let number = |s: &str| -> Option<u64> {
            if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
                // Longer than any real page number: out of range, not a syntax error.
                Some(s.parse::<u64>().unwrap_or(u64::MAX))
            } else {
                None
            }
        };
        if let Some(page) = number(token) {
            if page < 1 || page > total as u64 {
                return Err(CoreError::InvalidInput(format!(
                    "page {token} is out of range (document has {total} pages)"
                )));
            }
            groups.push(vec![page as u32]);
        } else if let Some((a, b)) = token.split_once('-').and_then(|(a, b)| Some((number(a)?, number(b)?))) {
            if a < 1 || b > total as u64 {
                return Err(CoreError::InvalidInput(format!(
                    "range '{token}' is out of range (document has {total} pages)"
                )));
            }
            if a > b {
                return Err(CoreError::InvalidInput(format!("range '{token}' is invalid: start must be at most end")));
            }
            groups.push((a as u32..=b as u32).collect());
        } else {
            return Err(CoreError::InvalidInput(format!(
                "'{token}' is not a valid page or range; use the format 1-3, 5, 7-9"
            )));
        }
    }
    if groups.is_empty() {
        return Err(CoreError::InvalidInput("no valid pages selected".into()));
    }
    Ok(groups)
}

/// Like [`parse`], but blank text selects every page.
pub fn select(text: &str, total: u32) -> CoreResult<Vec<u32>> {
    if text.trim().is_empty() {
        if total == 0 {
            return Err(CoreError::InvalidInput("the document has no pages".into()));
        }
        return Ok((1..=total).collect());
    }
    parse(text, total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_and_single_pages_are_merged_and_sorted() {
        assert_eq!(parse("5, 1-3,2", 9).unwrap(), vec![1, 2, 3, 5]);
        assert_eq!(parse("7", 7).unwrap(), vec![7]);
        assert_eq!(parse("1-2,,3", 3).unwrap(), vec![1, 2, 3]);
    }

    #[test]
    fn bad_selections_are_rejected() {
        for text in ["0", "10", "3-2", "1-99", "a", "1-", "-2", "1-2-3", "99999999999999999999999", " , "] {
            let err = parse(text, 9).unwrap_err();
            assert_eq!(err.code(), "invalid_input", "{text:?}");
        }
    }

    #[test]
    fn groups_keep_order_duplicates_and_one_group_per_token() {
        assert_eq!(parse_groups("3, 1-2, 3", 9).unwrap(), vec![vec![3], vec![1, 2], vec![3]]);
        assert_eq!(parse_groups("2-4", 9).unwrap(), vec![vec![2, 3, 4]]);
        assert!(parse_groups("1,10", 9).is_err());
        assert!(parse_groups(" , ", 9).is_err());
    }

    #[test]
    fn blank_means_all_pages_only_for_select() {
        assert_eq!(select("  ", 3).unwrap(), vec![1, 2, 3]);
        assert!(parse("", 3).is_err());
        assert!(select("", 0).is_err());
    }
}
