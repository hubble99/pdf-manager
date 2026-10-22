import { t } from '../../i18n';
import { baseName, extensionOf } from '../../utils/paths';

export type QuarterTurn = 0 | 90 | 180 | 270;

export interface ConverterImage {
  id: string;
  /** Path of the picture on disk. */
  path: string;
  rotation: QuarterTurn;
  flipH: boolean;
}

// Persist source paths only. Preview URLs belong to the mounted view.
// A string is the one PDF; an array is the image batch.
export type ConverterInput = string | ConverterImage[] | null;
export type ConverterKind = 'empty' | 'pdf' | 'images';

export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff'];

export function converterKind(input: ConverterInput): ConverterKind {
  if (typeof input === 'string') return 'pdf';
  return input?.length ? 'images' : 'empty';
}

export function classifyConverterPath(path: string): Exclude<ConverterKind, 'empty'> | null {
  const extension = extensionOf(path);
  if (extension === 'pdf') return 'pdf';
  return IMAGE_EXTENSIONS.includes(extension) ? 'images' : null;
}

export interface BatchAddition {
  input: ConverterInput;
  error: string | null;
}

let generatedId = 0;

function defaultCreateId(): string {
  generatedId += 1;
  return `image-${generatedId}`;
}

export function addConverterPaths(
  current: ConverterInput,
  incoming: readonly string[],
  createId: () => string = defaultCreateId,
): BatchAddition {
  const reject = (error: string): BatchAddition => ({ input: current, error });
  if (incoming.length === 0) return { input: current, error: null };

  const kinds = incoming.map(classifyConverterPath);
  if (kinds.some((kind) => kind === null)) {
    return reject(t('Use a PDF or JPG, JPEG, PNG, WEBP, BMP, or TIFF images. No files were added.'));
  }
  if (new Set(kinds).size !== 1) {
    return reject(t('PDFs and images cannot share a batch. Choose one PDF or only images.'));
  }
  const kind = kinds[0];
  if (kind === 'pdf' && incoming.length > 1) {
    return reject(t('Choose one PDF at a time. No files were added.'));
  }
  const currentKind = converterKind(current);
  if (currentKind !== 'empty' && currentKind !== kind) {
    return reject(t('PDFs and images cannot share a batch. Clear the current files before changing direction.'));
  }
  if (currentKind === 'pdf') {
    return reject(t('Remove the current PDF before adding another. Only one PDF is supported at a time.'));
  }
  if (kind === 'pdf') return { input: incoming[0], error: null };

  return {
    input: [
      ...(Array.isArray(current) ? current : []),
      ...incoming.map((path): ConverterImage => ({ id: createId(), path, rotation: 0, flipH: false })),
    ],
    error: null,
  };
}

export { baseName };
