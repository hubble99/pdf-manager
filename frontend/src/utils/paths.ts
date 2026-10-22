/**
 * Helpers for the file paths the desktop shell hands to native features.
 * Paths come from the system dialog or a window drop, so both Windows and
 * POSIX separators have to work.
 */

/** File name without its folder. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Lower-case extension without the dot, or '' when the name has none. */
export function extensionOf(path: string): string {
  const match = /\.([^.\\/]+)$/.exec(path);
  return match ? match[1].toLowerCase() : '';
}

/** File name without its folder and its last extension. */
export function stemOf(path: string): string {
  return baseName(path).replace(/\.[^.]+$/, '');
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
