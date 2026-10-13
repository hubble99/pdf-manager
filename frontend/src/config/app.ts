/**
 * Product identity, in one place.
 *
 * `tauri.conf.json` keeps its own product name for packaging and window chrome;
 * that is a build manifest rather than a runtime surface, so this module is the
 * single source for the name and tagline the interface displays.
 */
export const APP_NAME = 'PDF Manager';

export const APP_TAGLINE = 'Local document tools that keep your files on your device.';

/**
 * Deliberately about the product's job rather than about PDF alone: the direction
 * adds tools for other file types, so the description must not need rewriting
 * when they arrive.
 */
export const APP_DESCRIPTION =
  'Work with your documents and images in focused steps: combine, split, '
  + 'organize, convert, compress, protect, and edit. Everything runs on this '
  + 'device, files are never uploaded, and nothing is kept after you close the app.';
