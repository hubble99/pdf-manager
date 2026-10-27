/**
 * Product identity, in one place.
 *
 * `tauri.conf.json` keeps its own product name for packaging and window chrome;
 * that is a build manifest rather than a runtime surface, so this module is the
 * single source for the name and tagline the interface displays.
 */
import packageJson from '../../package.json';
import { t } from '../i18n';

export const APP_NAME = 'Dokuwu';

/**
 * The version the interface reports.
 *
 * `frontend/package.json` is the runtime version source and is kept in step with
 * `src-tauri/Cargo.toml` and `tauri.conf.json` at release time, so the UI never
 * hardcodes a version of its own. This matters because the reference design's
 * "v2.0 Productivity Suite" is a placeholder: the app must always show the
 * version that is actually running.
 */
export const APP_VERSION: string = packageJson.version;

/** Public repository and feedback destinations shown on Settings > About. */
export const APP_SOURCE_URL = 'https://github.com/hubble99/pdf-manager';
export const APP_TECH_STACK = 'Tauri 2, React 19, Vite, Rust, MuPDF, PDFium';

export const APP_TAGLINE = t('Local document tools that keep your files on your device.');

export const APP_PRIVACY_NOTE = t('Everything runs on this device. Files are never uploaded.');

/**
 * Deliberately about the product's job rather than about PDF alone: the direction
 * adds tools for other file types, so the description must not need rewriting
 * when they arrive.
 */
export const APP_DESCRIPTION = t(
  'Work with your documents and images in focused steps: combine, split, organize, convert, compress, protect, and edit. Everything runs on this device, files are never uploaded, and nothing is kept after you close the app.',
);
