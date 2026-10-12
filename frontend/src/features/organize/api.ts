import apiClient from '../../api/client';
import { getFilenameFromHeaders } from '../../utils/downloadHelper';
import type { SourceKind } from './types';

export interface UploadedDocument {
  documentId: string;
  name: string;
  kind: SourceKind;
  pageCount: number;
}

export interface ThumbnailBatch {
  total: number;
  pages: { page: number; data: string; width: number; height: number }[];
}

export interface AssemblePagePayload {
  source: string;
  page: number;
  rotation: number;
  flip: boolean;
}

export interface AssembledDocument {
  blob: Blob;
  filename: string;
  totalPages: number;
}

/** Upload one PDF or image once; later calls reference the returned handle. */
export async function uploadDocument(file: File): Promise<UploadedDocument> {
  const form = new FormData();
  form.append('file', file);
  const response = await apiClient.post<{ status: string; data: Record<string, unknown> }>(
    '/api/v1/organize/documents/',
    form,
  );
  const data = response.data.data;
  return {
    documentId: String(data.document_id),
    name: String(data.name),
    kind: data.kind === 'image' ? 'image' : 'pdf',
    pageCount: Number(data.page_count),
  };
}

/** Fetch one bounded batch of thumbnails for an uploaded document. */
export async function fetchThumbnails(
  documentId: string,
  start: number,
  count: number,
  targetWidth: number,
): Promise<ThumbnailBatch> {
  const response = await apiClient.post<{ status: string; data: ThumbnailBatch }>(
    `/api/v1/organize/documents/${documentId}/thumbnails/`,
    null,
    { params: { start, count, target_width: targetWidth } },
  );
  return response.data.data;
}

export async function releaseDocument(documentId: string): Promise<void> {
  await apiClient.delete(`/api/v1/organize/documents/${documentId}`);
}

/** Assemble the final page list into one PDF. */
export async function assembleDocument(
  pages: AssemblePagePayload[],
  outputFilename: string,
): Promise<AssembledDocument> {
  const response = await apiClient.post(
    '/api/v1/organize/assemble/',
    { pages, output_filename: outputFilename },
    { responseType: 'blob' },
  );
  const totalPages = parseInt(response.headers['x-total-pages'] || '0', 10);
  return {
    blob: new Blob([response.data], { type: 'application/pdf' }),
    filename: getFilenameFromHeaders(response.headers, outputFilename || 'organized.pdf'),
    totalPages,
  };
}

/** Turn the base64 payload the API returns into an object URL. */
export function thumbnailUrl(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
}

export function thumbnailKey(sourceId: string, page: number): string {
  return `${sourceId}:${page}`;
}
