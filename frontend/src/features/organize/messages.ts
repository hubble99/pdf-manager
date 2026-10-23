import { NativeCoreError } from '../../api/nativeCore';
import { t } from '../../i18n';

/** Organize failures from the core, in words that tell the user what to do. */
export function organizeErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof NativeCoreError)) return err instanceof Error ? err.message : fallback;
  const { code, message } = err;
  switch (code) {
    case 'password_required':
      return t('This PDF is protected. Remove the protection first, then organize its pages.');
    case 'not_found':
      return t('A file could not be found. It may have been moved or renamed.');
    case 'io':
      return t('The result could not be saved. Check that the Downloads folder is writable and has free space.');
    case 'insufficient_memory':
      return t('The computer is low on memory. Close other programs and try again.');
    case 'unsupported':
      return t('Use a PDF or a JPG, JPEG, PNG, WEBP, BMP, or TIFF image.');
    case 'invalid_input':
      if (message.includes('changed on disk')) return t('The file changed on disk since it was added. Add it again.');
      if (message.includes('no longer available')) return t('That document is no longer available. Add the file again.');
      if (message.startsWith('invalid input: Cannot open PDF')) return t('This file does not look like a valid PDF.');
      if (message.startsWith('invalid input: Cannot open image') || message.startsWith('invalid input: Cannot read image')) {
        return t('This file does not contain readable image data.');
      }
      if (message.includes('has no pages')) return t('The PDF has no pages.');
      return message.replace(/^invalid input: /, '');
    default:
      return message || fallback;
  }
}
