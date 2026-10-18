import apiClient from '../../api/client';
import { getFilenameFromHeaders } from '../../utils/downloadHelper';
import { t } from '../../i18n';

export interface FolderFileNode {
  name: string;
  relative_path: string;
  pdf_count: number;
  folders: FolderFileNode[];
  files: string[];
}

export interface FolderListing {
  root: FolderFileNode;
  pdf_count: number;
  skipped: number;
  depth_capped: boolean;
  entry_capped: boolean;
}

export interface RegisteredRoot {
  rootId: string;
  path: string;
  name: string;
}

export interface MergeProblem {
  path: string;
  reason: string;
}

export interface FolderMergeResult {
  blob: Blob;
  filename: string;
  totalPages: number;
  merged: number;
  skipped: number;
}

/** The message the backend uses when a registration has lapsed. */
export const CHOOSE_FOLDER_AGAIN = t('Choose folder again.');

export async function registerFolder(path: string): Promise<RegisteredRoot> {
  const response = await apiClient.post<{ status: string; data: Record<string, string> }>(
    '/api/v1/merge/folder/roots/',
    { path },
  );
  const data = response.data.data;
  return { rootId: data.root_id, path: data.path, name: data.name };
}

export async function listFolder(rootId: string): Promise<FolderListing> {
  const response = await apiClient.post<{ status: string; data: FolderListing }>(
    `/api/v1/merge/folder/roots/${rootId}/list/`,
  );
  return response.data.data;
}

export async function inspectFiles(rootId: string, files: string[]): Promise<MergeProblem[]> {
  const response = await apiClient.post<{ status: string; data: { problems: MergeProblem[] } }>(
    '/api/v1/merge/folder/inspect/',
    { root_id: rootId, files },
  );
  return response.data.data.problems;
}

export interface FileInfo {
  path: string;
  size_bytes: number;
  /** null when the file cannot be read (damaged or password-protected). */
  pages: number | null;
}

export async function describeFiles(rootId: string, files: string[]): Promise<FileInfo[]> {
  const response = await apiClient.post<{ status: string; data: { files: FileInfo[] } }>(
    '/api/v1/merge/folder/info/',
    { root_id: rootId, files },
  );
  return response.data.data.files;
}

export async function releaseFolder(rootId: string): Promise<void> {
  await apiClient.delete(`/api/v1/merge/folder/roots/${rootId}`);
}

export async function mergeFolderFiles(
  rootId: string,
  files: string[],
  outputFilename: string,
  skipInvalid: boolean,
): Promise<FolderMergeResult> {
  const response = await apiClient.post(
    '/api/v1/merge/folder/merge/',
    { root_id: rootId, files, output_filename: outputFilename, skip_invalid: skipInvalid },
    { responseType: 'blob' },
  );
  return {
    blob: new Blob([response.data], { type: 'application/pdf' }),
    filename: getFilenameFromHeaders(response.headers, outputFilename || 'merged_output.pdf'),
    totalPages: parseInt(response.headers['x-total-pages'] || '0', 10),
    merged: parseInt(response.headers['x-merged-files'] || '0', 10),
    skipped: parseInt(response.headers['x-skipped-files'] || '0', 10),
  };
}
