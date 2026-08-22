const INVALID_FILENAME_CHARS = /[<>:"/\\|?*]/g;
const GENERIC_EXTENSION = /\.[a-zA-Z0-9]{2,5}$/;
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

function normalizeStem(name: string, fallback: string): string {
  const withoutControlCharacters = Array.from(name, (character) =>
    character.charCodeAt(0) <= 31 ? '_' : character
  ).join('');
  let stem = withoutControlCharacters
    .replace(/\s+/g, ' ')
    .replace(INVALID_FILENAME_CHARS, '_')
    .replace(/_+/g, '_')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
    .replace(/^-+|-+$/g, '');

  if (!stem) stem = fallback;
  if (WINDOWS_RESERVED_NAMES.has(stem.split('.', 1)[0].toUpperCase())) {
    stem = `_${stem}`;
  }
  return stem;
}

export function sanitizeFilenameStem(name: string, fallback = 'output'): string {
  return normalizeStem(String(name || '').replace(GENERIC_EXTENSION, ''), fallback);
}

export function buildOutputFilename(name: string, extension: string, fallback = 'output'): string {
  const normalizedExtension = extension.toLowerCase().replace(/^\./, '');
  const withoutTargetExtension = String(name || '').replace(
    new RegExp(`\\.${normalizedExtension}$`, 'i'),
    '',
  );
  return `${normalizeStem(withoutTargetExtension, fallback)}.${normalizedExtension}`;
}

export function appendFilenameSuffix(name: string, suffix: string, fallback = 'output'): string {
  const stem = sanitizeFilenameStem(name, fallback);
  return stem.toLowerCase().endsWith(`_${suffix.toLowerCase()}`) ? stem : `${stem}_${suffix}`;
}
