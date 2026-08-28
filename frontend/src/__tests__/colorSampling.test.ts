import { describe, expect, it } from 'vitest';

import { sampleForegroundColor } from '../utils/colorSampling';

type Rgb = readonly [number, number, number];

function makeBuffer(width: number, height: number, color: Rgb) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = 255;
  }
  return { data, width, height };
}

function setPixel(buffer: ReturnType<typeof makeBuffer>, x: number, y: number, color: Rgb) {
  const offset = (y * buffer.width + x) * 4;
  buffer.data[offset] = color[0];
  buffer.data[offset + 1] = color[1];
  buffer.data[offset + 2] = color[2];
}

describe('sampleForegroundColor', () => {
  it('recovers the solid text color when the clicked edge pixel is anti-aliased', () => {
    const buffer = makeBuffer(11, 11, [255, 255, 255]);
    const text: Rgb = [51, 102, 153];
    const edge: Rgb = [197, 211, 226];

    for (let y = 3; y <= 7; y += 1) {
      setPixel(buffer, 4, y, edge);
      setPixel(buffer, 5, y, text);
      setPixel(buffer, 6, y, text);
      setPixel(buffer, 7, y, edge);
    }

    expect(sampleForegroundColor(buffer, 4, 5, 5)).toBe('#336699');
  });

  it('also recovers light text rendered over a dark background', () => {
    const buffer = makeBuffer(11, 11, [24, 28, 32]);
    const text: Rgb = [238, 224, 196];
    const edge: Rgb = [131, 126, 114];

    for (let x = 3; x <= 7; x += 1) {
      setPixel(buffer, x, 4, edge);
      setPixel(buffer, x, 5, text);
      setPixel(buffer, x, 6, text);
      setPixel(buffer, x, 7, edge);
    }

    expect(sampleForegroundColor(buffer, 5, 4, 5)).toBe('#eee0c4');
  });

  it('does not mistake a near-black anti-aliased edge for solid black text', () => {
    const buffer = makeBuffer(11, 11, [255, 255, 255]);

    for (let y = 3; y <= 7; y += 1) {
      setPixel(buffer, 4, y, [8, 8, 8]);
      setPixel(buffer, 5, y, [0, 0, 0]);
      setPixel(buffer, 6, y, [0, 0, 0]);
      setPixel(buffer, 7, y, [8, 8, 8]);
    }

    expect(sampleForegroundColor(buffer, 4, 5, 5)).toBe('#000000');
  });

  it('returns the clicked color when the sampled area is uniform', () => {
    const buffer = makeBuffer(5, 5, [17, 34, 51]);

    expect(sampleForegroundColor(buffer, 2, 2, 2)).toBe('#112233');
  });
});
