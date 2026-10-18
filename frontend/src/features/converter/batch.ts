import { t } from '../../i18n';
export type QuarterTurn = 0 | 90 | 180 | 270;

export interface ConverterImage {
  id: string;
  file: File;
  rotation: QuarterTurn;
  flipH: boolean;
}

// Persist source data only. Preview URLs belong to the mounted view.
export type ConverterInput = File | ConverterImage[] | null;
export type ConverterKind = 'empty' | 'pdf' | 'images';

export const CONVERTER_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.bmp,.tif,.tiff';

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff']);
const IMAGE_MIME_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
  'image/bmp', 'image/x-ms-bmp', 'image/tiff',
]);

export function converterKind(input: ConverterInput): ConverterKind {
  if (input instanceof File) return 'pdf';
  return input?.length ? 'images' : 'empty';
}

export function classifyConverterFile(file: File): Exclude<ConverterKind, 'empty'> | null {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const extensionKind = extension === 'pdf' ? 'pdf' : IMAGE_EXTENSIONS.has(extension) ? 'images' : null;
  const mime = file.type.toLowerCase();
  if (!mime || mime === 'application/octet-stream') return extensionKind;
  const mimeKind = mime === 'application/pdf' ? 'pdf' : IMAGE_MIME_TYPES.has(mime) ? 'images' : null;
  if (!mimeKind || (extensionKind && extensionKind !== mimeKind)) return null;
  return mimeKind;
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

export function addConverterFiles(
  current: ConverterInput,
  incoming: readonly File[],
  createId: () => string = defaultCreateId,
): BatchAddition {
  const reject = (error: string): BatchAddition => ({ input: current, error });
  if (incoming.length === 0) return { input: current, error: null };

  const kinds = incoming.map(classifyConverterFile);
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
      ...incoming.map((file): ConverterImage => ({ id: createId(), file, rotation: 0, flipH: false })),
    ],
    error: null,
  };
}
