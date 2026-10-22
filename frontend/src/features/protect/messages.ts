import { NativeCoreError } from '../../api/nativeCore';
import { t } from '../../i18n';

/** Protect failures, in words that tell the user what to do. */
export function protectErrorMessage(err: unknown): string {
  if (!(err instanceof NativeCoreError)) return err instanceof Error ? err.message : t('Unknown error');
  const { code, message } = err;
  switch (code) {
    case 'password_required':
      return t('Incorrect password. Please provide the correct user password.');
    case 'not_found':
      return t('The file could not be found. It may have been moved or renamed.');
    case 'io':
      return t('The result could not be saved. Check that the Downloads folder is writable and has free space.');
    case 'insufficient_memory':
      return t('The computer is low on memory. Close other programs and try again.');
    case 'invalid_input': {
      if (message.includes('already encrypted')) return t('This PDF is already encrypted. Remove the existing password first.');
      if (message.includes('not encrypted')) return t('This PDF is not encrypted - no password to remove.');
      if (message.includes('too long')) return t('The password is too long. Use at most 127 bytes (about 127 letters).');
      if (message.includes('null character')) return t('The password contains a character that cannot be used.');
      if (message.includes('User password is required')) return t('User password is required to encrypt the document.');
      return t('This file does not look like a valid PDF.');
    }
    default:
      return message;
  }
}
