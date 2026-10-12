import type { QuarterTurn } from './batch';

export interface ConverterOption<T extends string | number> {
  value: T;
  label: string;
  desc: string;
}

export const FORMAT_OPTIONS: ConverterOption<string>[] = [
  { value: 'PNG', label: 'PNG', desc: 'Lossless quality, larger size' },
  { value: 'JPEG', label: 'JPEG', desc: 'Lossy compression, smaller size' },
  { value: 'WEBP', label: 'WEBP', desc: 'Modern format, great size/quality ratio' },
];

export const DPI_OPTIONS: ConverterOption<number>[] = [
  { value: 72, label: '72 DPI', desc: 'Screen preview' },
  { value: 96, label: '96 DPI', desc: 'Standard display' },
  { value: 150, label: '150 DPI', desc: 'Balanced quality' },
  { value: 300, label: '300 DPI', desc: 'Print quality' },
];

export const PAGE_SIZE_OPTIONS: ConverterOption<string>[] = [
  { value: 'a4', label: 'A4', desc: '210 × 297 mm' },
  { value: 'a5', label: 'A5', desc: '148 × 210 mm' },
  { value: 'letter', label: 'Letter', desc: '216 × 279 mm' },
  { value: 'f4', label: 'F4', desc: '210 × 330 mm' },
  { value: 'a3', label: 'A3', desc: '297 × 420 mm' },
  { value: 'legal', label: 'Legal', desc: '216 × 356 mm' },
  { value: 'match_image', label: 'Original Image Size', desc: 'Each page follows its own image' },
];

export const ROTATION_STEP: QuarterTurn = 90;

export function nextRotation(rotation: QuarterTurn): QuarterTurn {
  return ((rotation + ROTATION_STEP) % 360) as QuarterTurn;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
