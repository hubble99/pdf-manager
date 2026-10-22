import { NativeCoreError } from '../api/nativeCore';
import { t } from '../i18n';

export { baseName, stemOf } from './paths';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function compressErrorMessage(err: unknown): string {
  if (err instanceof NativeCoreError) {
    switch (err.code) {
      case 'password_required':
        return t('This PDF is protected. Remove the protection first, then compress it.');
      case 'not_found':
        return t('The PDF could not be found. It may have been moved or renamed.');
      case 'invalid_input':
        return t('This file does not look like a valid PDF.');
      case 'io':
        return t('The compressed PDF could not be saved. Check that the Downloads folder is writable and has free space.');
      case 'insufficient_memory':
        return t('The computer is low on memory. Close other programs and try again.');
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : t('Unknown error');
}
