import { NativeCoreError } from '../../api/nativeCore';
import { t } from '../../i18n';

/** The core's reasons a file cannot be merged, in the user's language. */
export function reasonLabel(reason: string): string {
  switch (reason) {
    case 'not a PDF file': return t('not a PDF file');
    case 'file not found': return t('file not found');
    case 'not a file': return t('not a file');
    case 'encrypted': return t('password protected');
    case 'no pages': return t('no pages');
    case 'damaged or unreadable': return t('damaged or unreadable');
    case 'could not be read while merging': return t('could not be read while merging');
    default: return reason;
  }
}

/** Merge failures, in words that tell the user what to do. */
export function mergeErrorMessage(err: unknown): string {
  if (!(err instanceof NativeCoreError)) return err instanceof Error ? err.message : t('Unknown error');
  const { code, message } = err;
  switch (code) {
    case 'not_found':
      return t('A file could not be found. It may have been moved or renamed.');
    case 'io':
      return t('The result could not be saved. Check that the Downloads folder is writable and has free space.');
    case 'insufficient_memory':
      return t('The computer is low on memory. Close other programs and try again.');
    case 'invalid_input': {
      const encrypted = /'(.+)' is encrypted and cannot be merged/.exec(message);
      if (encrypted) return t('{name} is password protected and cannot be merged. Remove its protection first.', { name: encrypted[1] });
      const unreadable = /Cannot open '(.+)':/.exec(message);
      if (unreadable) return t('{name} could not be opened. It may be damaged.', { name: unreadable[1] });
      if (message.includes('At least 2 PDF files')) return t('Add at least 2 PDF files to merge.');
      if (message.includes('Fewer than 2 files')) return t('Fewer than 2 files can be merged after skipping the reported problems.');
      if (message.includes('None of the provided files')) return t('None of the files could be merged.');
      if (message.includes('inside the chosen folder') || message.includes('outside the chosen folder')
        || message.includes('Only PDF files')) {
        return t('Use PDF files inside the chosen folder.');
      }
      if (message.includes('does not exist or is not a folder')) return t('That folder could not be read.');
      return message;
    }
    default:
      return message;
  }
}

/** Extract failures, with the page range problems explained. */
export function extractErrorMessage(err: unknown): string {
  if (!(err instanceof NativeCoreError)) return err instanceof Error ? err.message : t('Unknown error');
  const { code, message } = err;
  switch (code) {
    case 'password_required':
      return t('This PDF is protected. Remove the protection first, then split its pages.');
    case 'not_found':
      return t('A file could not be found. It may have been moved or renamed.');
    case 'io':
      return t('The result could not be saved. Check that the Downloads folder is writable and has free space.');
    case 'insufficient_memory':
      return t('The computer is low on memory. Close other programs and try again.');
    case 'invalid_input': {
      let match = /page (\d+) is out of range \(document has (\d+) pages?\)/.exec(message);
      if (match) return t('Page {page} is out of range. The document has {total} pages.', { page: match[1], total: match[2] });
      match = /range '(.+)' is out of range \(document has (\d+) pages?\)/.exec(message);
      if (match) return t('Range {range} is out of range. The document has {total} pages.', { range: match[1], total: match[2] });
      match = /range '(.+)' is invalid: start must be at most end/.exec(message);
      if (match) return t('Range {range} is invalid: the first page must not be after the last.', { range: match[1] });
      match = /'(.+)' is not a valid page or range/.exec(message);
      if (match) return t('{token} is not a valid page or range. Use the format 1-3, 5, 7-9.', { token: match[1] });
      if (message.includes('page range string is empty') || message.includes('no valid pages')) {
        return t('Enter page ranges, e.g. 1-3,5,7-9');
      }
      return t('This file does not look like a valid PDF.');
    }
    default:
      return message;
  }
}
