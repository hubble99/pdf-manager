// ── API Response shapes ───────────────────────────────────────────────────────

export interface ApiSuccess<T = unknown> {
  status: 'success';
  data: T;
  message?: string;
}

export interface ApiError {
  status: 'error';
  message: string;
  detail?: string;
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;

// ── File info ─────────────────────────────────────────────────────────────────

export interface FileInfo {
  filename: string;
  size_bytes: number;
  path: string;
}

export interface ProcessingResult {
  status: 'success' | 'error';
  output_file?: FileInfo;
  output_files?: FileInfo[];
  message?: string;
}

// ── Health ────────────────────────────────────────────────────────────────────

export interface HealthData {
  version: string;
  output_dir: string;
  temp_dir: string;
}

// ── Navigation ────────────────────────────────────────────────────────────────

export type NavItemId =
  | 'merge'
  | 'extract'
  | 'compress'
  | 'pdf-to-image'
  | 'image-to-pdf'
  | 'qr-barcode'
  | 'insert'
  | 'organize'
  | 'metadata'
  | 'protect';

// ── Feature-specific request types ───────────────────────────────────────────

export interface MergeRequest {
  files: File[];
  outputFilename: string;
}

export interface ExtractRequest {
  file: File;
  page_ranges: string; // e.g. "1-3,5,7-9"
  output_mode: 'combine' | 'separate_page' | 'separate_range' | 'split_all';
}

export interface CompressRequest {
  file: File;
  quality: number; // 10-95
}

export interface PdfToImageRequest {
  file: File;
  format: 'PNG' | 'JPEG' | 'WEBP';
  dpi: number;
}

export interface ImageToPdfRequest {
  files: File[];
  page_size: 'A4' | 'A3' | 'Letter' | 'Legal';
}

export interface QRRequest {
  content: string;
  size: number;
  error_correction: 'L' | 'M' | 'Q' | 'H';
  format: 'png' | 'svg';
  border: number;
}

export interface BarcodeRequest {
  content: string;
  barcode_type: 'code128' | 'ean13' | 'ean8' | 'code39';
  format: 'png' | 'svg';
}

// ── Feature-specific result types (Sprint 2) ─────────────────────────────────

export interface MergeResult {
  outputFile: string;
  totalPages: number;
  fileSizeBytes: number;
}

export interface ExtractResult {
  outputFile: string;
  pagesExtracted: number;
  outputMode: string;
}

export interface CompressResult {
  outputFile: string;
  sizeBefore: number;
  sizeAfter: number;
  reductionPct: number;
  imagesProcessed: number;
}

export interface PdfInfoResult {
  filename: string;
  total_pages: number;
  file_size_bytes: number;
}

export interface PdfToImageResult {
  pagesExported: number;
  format: string;
  dpi: number;
  filename: string;
  isZip: boolean;
}

export interface ImageToPdfResult {
  totalPages: number;
  pageSize: string;
  filename: string;
  fileSizeBytes: number;
}
