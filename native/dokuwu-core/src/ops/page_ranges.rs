//! Page selections such as `1-3,5,7-9`.

use crate::error::{CoreError, CoreResult};

/// Parses `text` against a document of `total` pages and returns the pages it
/// names, 1-based, sorted and without duplicates. Blank text is an error; use
/// [`select`] to mean "all pages".
pub fn parse(text: &str, total: u32) -> CoreResult<Vec<u32>> {
    if text.trim().is_empty() {
        return Err(CoreError::InvalidInput("page range string is empty".into()));
    }
    let mut pages = Vec::new();
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
            pages.push(page as u32);
        } else if let Some((a, b)) = token.split_once('-').and_then(|(a, b)| Some((number(a)?, number(b)?))) {
            if a < 1 || b > total as u64 {
                return Err(CoreError::InvalidInput(format!(
                    "range '{token}' is out of range (document has {total} pages)"
                )));
            }
            if a > b {
                return Err(CoreError::InvalidInput(format!("range '{token}' is invalid: start must be at most end")));
            }
            pages.extend(a as u32..=b as u32);
        } else {
            return Err(CoreError::InvalidInput(format!(
                "'{token}' is not a valid page or range; use the format 1-3, 5, 7-9"
            )));
        }
    }
    pages.sort_unstable();
    pages.dedup();
    if pages.is_empty() {
        return Err(CoreError::InvalidInput("no valid pages selected".into()));
    }
    Ok(pages)
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
    fn blank_means_all_pages_only_for_select() {
        assert_eq!(select("  ", 3).unwrap(), vec![1, 2, 3]);
        assert!(parse("", 3).is_err());
        assert!(select("", 0).is_err());
    }
}
