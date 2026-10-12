import { describe, expect, it } from 'vitest';
import { checkFileKind } from '../features/organize/fileKind';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n%...');
const PDF_RENAMED = new TextEncoder().encode('%PDF-1.7\n%...');
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const TEXT_BYTES = new TextEncoder().encode('just some notes here');

function file(name: string, bytes: Uint8Array, type = '') {
  // A fresh allocation keeps the buffer non-shared, which BlobPart requires.
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('insert file type checking', () => {
  it('accepts a real PDF for a PDF insert', async () => {
    expect((await checkFileKind(file('report.pdf', PDF_BYTES, 'application/pdf'), 'pdf')).ok).toBe(true);
  });

  it('refuses an image chosen for a PDF insert', async () => {
    const verdict = await checkFileKind(file('photo.png', PNG_BYTES, 'image/png'), 'pdf');
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain('not a PDF');
  });

  it('accepts supported image content for an image insert', async () => {
    for (const [name, bytes] of [['a.png', PNG_BYTES], ['b.jpg', JPEG_BYTES]] as const) {
      expect((await checkFileKind(file(name, bytes), 'image')).ok, name).toBe(true);
    }
  });

  it('refuses a PDF that was renamed as an image', async () => {
    const verdict = await checkFileKind(file('not-really.png', PDF_RENAMED), 'image');
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toBeTruthy();
  });

  it('refuses a plain text file that claims to be an image', async () => {
    // The extension is one we accept but the content is not an image at all.
    const verdict = await checkFileKind(file('notes.png', TEXT_BYTES), 'image');
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain('readable image data');
  });

  it('refuses an unsupported extension with no image content', async () => {
    const verdict = await checkFileKind(file('notes.txt', TEXT_BYTES, 'text/plain'), 'image');
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain('not a supported image');
  });

  it('refuses an unsupported extension even when the content looks like an image', async () => {
    const verdict = await checkFileKind(file('photo.gif', PNG_BYTES), 'image');
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain('unsupported extension');
  });
});
