import { describe, expect, it } from 'vitest';
import { NativeCoreError } from '../api/nativeCore';
import { extractErrorMessage, mergeErrorMessage, reasonLabel } from '../features/merge/messages';

const err = (code: ConstructorParameters<typeof NativeCoreError>[0], message: string) => new NativeCoreError(code, message);

describe('merge and extract messages', () => {
  it('labels every reason the core can give', () => {
    for (const reason of ['not a PDF file', 'file not found', 'not a file', 'encrypted', 'no pages', 'damaged or unreadable', 'could not be read while merging']) {
      expect(reasonLabel(reason).length).toBeGreaterThan(0);
    }
    expect(reasonLabel('something new')).toBe('something new');
  });

  it('turns the core merge errors into plain words', () => {
    expect(mergeErrorMessage(err('invalid_input', 'invalid input: At least 2 PDF files are required to merge.')))
      .toBe('Add at least 2 PDF files to merge.');
    expect(mergeErrorMessage(err('invalid_input', 'invalid input: Use a file inside the chosen folder.')))
      .toBe('Use PDF files inside the chosen folder.');
    expect(mergeErrorMessage(err('not_found', 'file not found: x')))
      .toBe('A file could not be found. It may have been moved or renamed.');
    expect(mergeErrorMessage(err('internal', 'boom'))).toBe('boom');
    expect(mergeErrorMessage(new Error('plain'))).toBe('plain');
  });

  it('explains page range problems', () => {
    expect(extractErrorMessage(err('invalid_input', "invalid input: range '1-99' is out of range (document has 6 pages)")))
      .toBe('Range 1-99 is out of range. The document has 6 pages.');
    expect(extractErrorMessage(err('invalid_input', "invalid input: range '3-1' is invalid: start must be at most end")))
      .toBe('Range 3-1 is invalid: the first page must not be after the last.');
    expect(extractErrorMessage(err('invalid_input', "invalid input: 'abc' is not a valid page or range; use the format 1-3, 5, 7-9")))
      .toBe('abc is not a valid page or range. Use the format 1-3, 5, 7-9.');
    expect(extractErrorMessage(err('invalid_input', 'invalid input: page range string is empty')))
      .toBe('Enter page ranges, e.g. 1-3,5,7-9');
    expect(extractErrorMessage(err('password_required', 'x')))
      .toBe('This PDF is protected. Remove the protection first, then split its pages.');
    expect(extractErrorMessage(err('invalid_input', 'invalid input: Cannot open PDF: x')))
      .toBe('This file does not look like a valid PDF.');
  });
});
