import { t } from '../../i18n';
/**
 * Strict page-expression parsing shared by the insert "Pick" field and the bulk
 * delete field.
 *
 * Semantics: single pages, inclusive ranges, comma-separated combinations.
 * Requested order and duplicates are preserved, because both picking an insert
 * order and naming positions must mean exactly what the user typed. Malformed
 * tokens, reversed ranges, and out-of-range values are rejected with an inline
 * message rather than being ignored, clamped, or dropped.
 */
export interface PageExpressionResult {
  valid: boolean;
  /** Requested pages in order, with duplicates preserved. */
  pages: number[];
  error: string | null;
}

const TOKEN = /^(\d+)(?:\s*-\s*(\d+))?$/;

export function parsePageExpression(input: string, total: number): PageExpressionResult {
  const invalid = (error: string): PageExpressionResult => ({ valid: false, pages: [], error });

  if (!Number.isSafeInteger(total) || total < 1) {
    return invalid(t('Load a document before choosing pages.'));
  }
  if (!input.trim()) {
    return invalid(t('Choose at least one page. Enter a page or range, such as 2, 4-7.'));
  }

  const pages: number[] = [];
  for (const rawToken of input.split(',')) {
    const token = rawToken.trim();
    if (!token) {
      return invalid(t('Choose at least one page. Enter a page or range, such as 2, 4-7.'));
    }

    const match = TOKEN.exec(token);
    if (!match) {
      return invalid(t('"{token}" is not a page or range. Use a form such as 2, 4-7.', { token }));
    }

    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);

    if (start < 1 || end > total) {
      return invalid(t('Pages must be between 1 and {total}.', { total }));
    }
    if (start > end) {
      return invalid(t('"{token}" counts backwards. Write the smaller page first.', { token }));
    }

    for (let page = start; page <= end; page++) pages.push(page);
  }

  return { valid: true, pages, error: null };
}

/** Canonical text for a set of page numbers, collapsing runs (ascending). */
export function formatPageNumbers(pages: Iterable<number>): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let index = 0; index < sorted.length; index++) {
    const start = sorted[index];
    let end = start;
    while (sorted[index + 1] === end + 1) end = sorted[++index];
    parts.push(start === end ? String(start) : `${start}-${end}`);
  }
  return parts.join(', ');
}
