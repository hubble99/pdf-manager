import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  ensureApplicationFontFace,
  getAvailableFontWeights,
  loadApplicationFontLibrary,
  mergeFontFamilies,
  nearestAvailableFontWeight,
  getSelectableFontWeights,
  resolveFontFace,
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
    invoke.mockReset();
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
    invoke.mockResolvedValueOnce(fonts);

    const result = await loadApplicationFontLibrary();

    expect(result).toEqual({ families: ['Roboto'], entries: fonts });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('core_font_list', undefined);
    expect(add).not.toHaveBeenCalled();
  });

  it('downloads only the selected face with numeric weight descriptors', async () => {
    const fonts = [
      { id: 'poppins-medium', family: 'Poppins', filename: 'Poppins-Medium.ttf', weight: 500, bold: false, italic: false },
      { id: 'poppins-medium-italic', family: 'Poppins', filename: 'Poppins-MediumItalic.ttf', weight: 500, bold: false, italic: true },
    ];
    invoke.mockResolvedValueOnce(new ArrayBuffer(8));

    await expect(ensureApplicationFontFace(fonts, 'Poppins', 500, true)).resolves.toBe(true);

    expect(invoke).toHaveBeenCalledWith('core_font_read', { id: 'poppins-medium-italic' });
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

  it('offers in-between weights for limited families and resolves them to a lighter real face', () => {
    expect(getSelectableFontWeights('Arial', [])).toEqual([400, 450, 500, 550, 700]);
    expect(getSelectableFontWeights('Calibri', [])).toEqual([300, 400, 450, 500, 550, 700]);

    const arimo = [
      { id: 'a', family: 'Arimo', filename: 'a.ttf', weight: 400, bold: false, italic: false },
      { id: 'b', family: 'Arimo', filename: 'b.ttf', weight: 500, bold: false, italic: false },
      { id: 'c', family: 'Arimo', filename: 'c.ttf', weight: 700, bold: true, italic: false },
    ];
    expect(getSelectableFontWeights('Arimo', arimo)).toEqual([400, 450, 500, 550, 700]);

    expect(resolveFontFace(400, [400, 700])).toEqual({ faceWeight: 400, strokeEm: 0 });
    expect(resolveFontFace(700, [400, 700])).toEqual({ faceWeight: 700, strokeEm: 0 });
    const medium = resolveFontFace(500, [400, 700]);
    expect(medium.faceWeight).toBe(400);
    expect(medium.strokeEm).toBeCloseTo(0.02);
    const fromMedium = resolveFontFace(550, [400, 500, 700]);
    expect(fromMedium.faceWeight).toBe(500);
    expect(fromMedium.strokeEm).toBeCloseTo(0.01);
    expect(resolveFontFace(500, [400, 500, 700])).toEqual({ faceWeight: 500, strokeEm: 0 });
  });
});
