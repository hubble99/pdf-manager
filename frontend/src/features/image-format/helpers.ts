/**
 * Pure helpers for the WEBP conversion page, kept apart so they can be tested
 * without the Tauri runtime.
 */
import type { CoreErrorCode, ImageTargetFormat } from '../../api/nativeCore';
import { t } from '../../i18n';

export const DEFAULT_JPEG_QUALITY = 90;

/** File name without its folder, for either path separator. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Path key for duplicate checks; Windows paths are case-insensitive. */
const pathKey = (path: string) => path.replace(/\//g, '\\').toLowerCase();

/** Appends `incoming` to `current`, skipping paths already in the list. */
export function mergePaths(current: string[], incoming: string[]): { paths: string[]; skipped: number } {
  const seen = new Set(current.map(pathKey));
  const paths = [...current];
  let skipped = 0;
  for (const path of incoming) {
    const key = pathKey(path);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    paths.push(path);
  }
  return { paths, skipped };
}

/** Only `.webp` files are offered; the engine still checks the content. */
export function isWebpPath(path: string): boolean {
  return /\.webp$/i.test(path);
}

export function isJpegFormat(format: ImageTargetFormat): boolean {
  return format === 'jpg' || format === 'jpeg';
}

/** A short, translated reason for one file that could not be converted. */
export function convertErrorText(code: CoreErrorCode | undefined): string {
  switch (code) {
    case 'not_found':
      return t('The file is no longer there.');
    case 'unsupported':
      return t('This is not a WEBP image.');
    case 'invalid_input':
      return t('The image is damaged or cannot be read.');
    case 'io':
      return t('The file could not be read or saved. Check the folder permissions.');
    case 'insufficient_memory':
      return t('Not enough free memory for this image. Close other apps and try again.');
    default:
      return t('Unexpected error while converting this image.');
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
