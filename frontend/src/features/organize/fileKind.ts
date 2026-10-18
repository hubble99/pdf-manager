/**
 * Confirm that a chosen file really is the kind of document the action expects.
 *
 * A file dialog can be switched to "All files", so the extension is not proof.
 * The check therefore reads the file's own header as well: a wrong file must be
 * refused before it is uploaded, with a message that names the problem.
 */
import { IMAGE_EXTENSIONS, type SourceKind } from './types';
import { t } from '../../i18n';

export interface FileKindCheck {
  ok: boolean;
  error: string | null;
}

const PDF_MAGIC = '%PDF-';

const IMAGE_MAGIC: { test: (bytes: Uint8Array) => boolean; label: string }[] = [
  { label: 'PNG', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { label: 'JPEG', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { label: 'WEBP', test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
  { label: 'BMP', test: (b) => b[0] === 0x42 && b[1] === 0x4d },
  { label: 'TIFF', test: (b) => (b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d) },
];

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

function looksLikePdf(bytes: Uint8Array): boolean {
  return String.fromCharCode(...bytes.slice(0, PDF_MAGIC.length)) === PDF_MAGIC;
}

export async function checkFileKind(file: File, expected: SourceKind): Promise<FileKindCheck> {
  const ext = extension(file.name);
  const buffer = await file.slice(0, 12).arrayBuffer();
  const header = new Uint8Array(buffer as ArrayBuffer);

  if (expected === 'pdf') {
    if (looksLikePdf(header)) return { ok: true, error: null };
    return {
      ok: false,
      error: t('{name} is not a PDF file. Choose a PDF for this action.', { name: file.name }),
    };
  }

  const imageLabel = IMAGE_MAGIC.find((candidate) => candidate.test(header))?.label;
  if (imageLabel) {
    if (ext && !(IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
      return {
        ok: false,
        error: t('{name} looks like a {kind} but has an unsupported extension.', { name: file.name, kind: imageLabel }),
      };
    }
    return { ok: true, error: null };
  }

  if (!ext || !(IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
    return {
      ok: false,
      error: t('{name} is not a supported image. Use PNG, JPEG, WEBP, BMP, or TIFF.', { name: file.name }),
    };
  }
  return {
    ok: false,
    error: t('{name} does not contain readable image data.', { name: file.name }),
  };
}
