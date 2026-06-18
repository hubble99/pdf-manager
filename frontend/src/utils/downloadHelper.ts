/**
 * Shared download utility for single-step process & download flow.
 *
 * Usage:
 *   const filename = getFilenameFromHeaders(response.headers)
 *   triggerBlobDownload(blob, filename)
 */

import type { AxiosResponseHeaders, RawAxiosResponseHeaders } from 'axios';

/**
 * Extract the filename from the Content-Disposition header, falling back to
 * the X-Output-File header, and then to `fallback`.
 */
export function getFilenameFromHeaders(
  headers: AxiosResponseHeaders | RawAxiosResponseHeaders | Record<string, string>,
  fallback: string
): string {
  // Try Content-Disposition first
  const cd = headers['content-disposition'] as string | undefined;
  if (cd) {
    const match = cd.match(/filename="([^"]+)"/);
    if (match?.[1]) return match[1];
  }

  // Try X-Output-File custom header
  const xof = headers['x-output-file'] as string | undefined;
  if (xof) return xof;

  return fallback;
}

/**
 * Trigger a browser download of a Blob with the given filename.
 * Creates and immediately clicks a temporary <a> element.
 */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a short delay to ensure the download starts
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
