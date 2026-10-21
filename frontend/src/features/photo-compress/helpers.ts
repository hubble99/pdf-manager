/**
 * Pure helpers for the photo compression page, kept apart so they can be
 * tested without the Tauri runtime.
 */
import type { CoreErrorCode } from '../../api/nativeCore';
import { t } from '../../i18n';

export type CompressLevel = 'light' | 'balanced' | 'strong' | 'custom';

export interface LevelSettings {
  quality: number;
  /** Longest side in pixels, or `null` to keep the original size. */
  maxSide: number | null;
}

/** What each ready-made level means. "Custom" keeps whatever the user set. */
export const LEVELS: Record<Exclude<CompressLevel, 'custom'>, LevelSettings> = {
  light: { quality: 85, maxSide: null },
  balanced: { quality: 75, maxSide: 2560 },
  strong: { quality: 60, maxSide: 1600 },
};

export const DEFAULT_LEVEL: Exclude<CompressLevel, 'custom'> = 'balanced';

export const MAX_SIDE_CHOICES: number[] = [3840, 2560, 1920, 1600, 1280, 1024];

/** Only JPEG and PNG are offered; the engine still checks the content. */
export function isPhotoPath(path: string): boolean {
  return /\.(jpe?g|jfif|png)$/i.test(path);
}

/** Share of the original size that was saved, 0 when nothing was. */
export function savedPercent(originalBytes: number, outputBytes: number): number {
  if (originalBytes <= 0 || outputBytes >= originalBytes) return 0;
  return Math.round((1 - outputBytes / originalBytes) * 100);
}

/** A short, translated reason for one photo that could not be compressed. */
export function compressErrorText(code: CoreErrorCode | undefined): string {
  switch (code) {
    case 'not_found':
      return t('The file is no longer there.');
    case 'unsupported':
      return t('This is not a JPEG or PNG photo.');
    case 'invalid_input':
      return t('The image is damaged or cannot be read.');
    case 'io':
      return t('The file could not be read or saved. Check the folder permissions.');
    case 'insufficient_memory':
      return t('Not enough free memory for this image. Close other apps and try again.');
    default:
      return t('Unexpected error while compressing this photo.');
  }
}
