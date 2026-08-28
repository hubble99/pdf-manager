import { beforeEach, describe, expect, it, vi } from 'vitest';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../api/client', () => ({
  default: { get },
}));

import {
  ensureApplicationFontFace,
  getAvailableFontWeights,
  loadApplicationFontLibrary,
  mergeFontFamilies,
  nearestAvailableFontWeight,
  toggleBoldWeight,
} from '../features/edit-canvas/fontLibrary';

class MockFontFace {
  family: string;
  source: ArrayBuffer;
  descriptors: FontFaceDescriptors;

  constructor(family: string, source: ArrayBuffer, descriptors: FontFaceDescriptors) {
    this.family = family;
    this.source = source;
    this.descriptors = descriptors;
  }

  async load() {
    return this;
  }
}

describe('Edit Canvas application font library', () => {
  const add = vi.fn();

  beforeEach(() => {
    get.mockReset();
    add.mockReset();
    vi.stubGlobal('FontFace', MockFontFace);
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { add },
    });
  });

  it('loads the catalog without downloading every face', async () => {
    const fonts = [
      { id: 'roboto-regular', family: 'Roboto', filename: 'Roboto-Regular.ttf', weight: 400, bold: false, italic: false },
      { id: 'roboto-medium', family: 'Roboto', filename: 'Roboto-Medium.ttf', weight: 500, bold: false, italic: false },
    ];
    get.mockResolvedValueOnce({ data: { fonts } });

    const result = await loadApplicationFontLibrary();

    expect(result).toEqual({ families: ['Roboto'], entries: fonts });
    expect(get).toHaveBeenCalledTimes(1);
    expect(add).not.toHaveBeenCalled();
  });

  it('downloads only the selected face with numeric weight descriptors', async () => {
    const fonts = [
      { id: 'poppins-medium', family: 'Poppins', filename: 'Poppins-Medium.ttf', weight: 500, bold: false, italic: false },
      { id: 'poppins-medium-italic', family: 'Poppins', filename: 'Poppins-MediumItalic.ttf', weight: 500, bold: false, italic: true },
    ];
    get.mockResolvedValueOnce({ data: new ArrayBuffer(8) });

    await expect(ensureApplicationFontFace(fonts, 'Poppins', 500, true)).resolves.toBe(true);

    expect(get).toHaveBeenCalledWith('/api/v1/fonts/poppins-medium-italic/file', { responseType: 'arraybuffer' });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0]).toMatchObject({
      family: 'Poppins',
      descriptors: { weight: '500', style: 'italic' },
    });
  });

  it('merges app families without duplicating built-in options', () => {
    expect(mergeFontFamilies(['Arial', 'Roboto'], ['Roboto', 'Poppins', 'Arimo']))
      .toEqual(['Arial', 'Roboto', 'Arimo', 'Poppins']);
  });

  it('exposes only weights available for the selected family', () => {
    const fonts = [
      { id: 'arimo-regular', family: 'Arimo', filename: 'Arimo-Regular.ttf', weight: 400, bold: false, italic: false },
      { id: 'arimo-medium', family: 'Arimo', filename: 'Arimo-Medium.ttf', weight: 500, bold: false, italic: false },
      { id: 'arimo-bold', family: 'Arimo', filename: 'Arimo-Bold.ttf', weight: 700, bold: true, italic: false },
    ];

    expect(getAvailableFontWeights('Arimo', fonts)).toEqual([400, 500, 700]);
    expect(getAvailableFontWeights('Calibri', fonts)).toEqual([300, 400, 700]);
  });

  it('selects a predictable nearest weight and keeps the Bold shortcut in sync', () => {
    expect(nearestAvailableFontWeight(600, [400, 500, 700])).toBe(700);
    expect(toggleBoldWeight(500, [400, 500, 700])).toBe(700);
    expect(toggleBoldWeight(700, [400, 500, 700])).toBe(400);
  });
});
