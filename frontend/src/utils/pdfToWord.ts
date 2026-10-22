import { NativeCoreError } from '../api/nativeCore';
import { t } from '../i18n';

export { baseName, stemOf } from './paths';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** "1, 2, 5" with at most `max` numbers, then "…". */
export function pageList(pages: number[], max = 8): string {
  const shown = pages.slice(0, max).join(', ');
  return pages.length > max ? `${shown}, …` : shown;
}

export function errorMessage(err: unknown): string {
  if (err instanceof NativeCoreError) {
    switch (err.code) {
      case 'password_required':
        return t('This PDF is password protected. Remove the password with Protect PDF, then try again.');
      case 'not_found':
        return t('The PDF could not be found. It may have been moved or deleted.');
      case 'invalid_input':
        return t('This file could not be read as a PDF.');
      case 'io':
        return t('The Word file could not be saved. Check that the Downloads folder is writable and has free space.');
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : t('Unknown error');
}
