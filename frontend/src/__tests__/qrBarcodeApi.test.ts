import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyLanguage } from '../i18n';
import { NativeCoreError } from '../api/nativeCore';
import { generateBarcode, generateQr, generationErrorText } from '../api/qrBarcode';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

describe('qr and barcode commands', () => {
  beforeEach(() => invokeMock.mockReset());
  afterEach(() => applyLanguage('en'));

  it('calls the QR command with camelCase arguments and returns the bytes', async () => {
    invokeMock.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    await expect(
      generateQr({ content: 'hi', size: 8, errorCorrection: 'Q', format: 'svg', border: 2 })
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(invokeMock).toHaveBeenCalledWith('core_qr_generate', {
      content: 'hi',
      size: 8,
      errorCorrection: 'Q',
      format: 'svg',
      border: 2,
    });
  });

  it('calls the barcode command', async () => {
    invokeMock.mockResolvedValue(new ArrayBuffer(0));
    await generateBarcode({ content: '590123412345', barcodeType: 'ean13', format: 'png' });
    expect(invokeMock).toHaveBeenCalledWith('core_barcode_generate', {
      content: '590123412345',
      barcodeType: 'ean13',
      format: 'png',
    });
  });

  it('accepts the bytes as a typed array or a plain number array too', async () => {
    invokeMock.mockResolvedValueOnce([137, 80, 78, 71]);
    await expect(generateBarcode({ content: 'a', barcodeType: 'code128', format: 'png' })).resolves.toEqual(
      new Uint8Array([137, 80, 78, 71])
    );
    invokeMock.mockResolvedValueOnce(new Uint8Array([1, 2]));
    await expect(generateBarcode({ content: 'a', barcodeType: 'code128', format: 'png' })).resolves.toEqual(
      new Uint8Array([1, 2])
    );
  });

  it('reports an answer that is not bytes instead of drawing garbage', async () => {
    invokeMock.mockResolvedValueOnce('oops');
    await expect(generateQr({ content: 'a', size: 8, errorCorrection: 'M', format: 'png' })).rejects.toMatchObject({
      code: 'internal',
    });
  });

  it('turns the core error payload into a NativeCoreError', async () => {
    invokeMock.mockRejectedValueOnce({ code: 'invalid_input', message: 'invalid input: Content cannot be empty.' });
    let error: unknown;
    try {
      await generateQr({ content: ' ', size: 8, errorCorrection: 'M', format: 'png' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(NativeCoreError);
    expect((error as NativeCoreError).code).toBe('invalid_input');
  });

  it('words the errors a user can reach, in the active language', () => {
    const wrongDigit = new NativeCoreError('invalid_input', 'invalid input: The check digit of this EAN-13 is wrong, it should be 7.');
    expect(generationErrorText(wrongDigit)).toBe('The check digit of this EAN-13 is wrong, it should be 7.');
    applyLanguage('id');
    expect(generationErrorText(wrongDigit)).toBe('Digit pemeriksa EAN-13 ini salah, seharusnya 7.');
    expect(
      generationErrorText(new NativeCoreError('invalid_input', 'invalid input: The following characters are not valid for Code 128: é, ü'))
    ).toBe('Code 128 tidak boleh berisi: é, ü');
    expect(generationErrorText(new NativeCoreError('invalid_input', 'invalid input: Content is too long for a QR code.'))).toBe(
      'Konten terlalu panjang untuk kode QR.'
    );
  });

  it('shows the reason for an unexpected failure so it can be reported', () => {
    expect(generationErrorText(new NativeCoreError('internal', 'internal error: boom'))).toBe(
      'Unexpected error while generating: internal error: boom'
    );
    expect(generationErrorText(new Error('weird'))).toBe('Unexpected error while generating: weird');
  });
});
