export interface PixelBuffer {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function toHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

type Rgb = readonly [number, number, number];

function colorKey([red, green, blue]: Rgb): string {
  return `${red},${green},${blue}`;
}

function colorDistanceSquared(first: Rgb, second: Rgb): number {
  const red = first[0] - second[0];
  const green = first[1] - second[1];
  const blue = first[2] - second[2];
  return red * red + green * green + blue * blue;
}

function readPixel(image: PixelBuffer, x: number, y: number): Rgb {
  const offset = (y * image.width + x) * 4;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

function mostFrequentColor(colors: Rgb[]): Rgb {
  const counts = new Map<string, { color: Rgb; count: number }>();
  let winner = { color: colors[0], count: 0 };

  for (const color of colors) {
    const key = colorKey(color);
    const entry = counts.get(key) ?? { color, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
    if (entry.count > winner.count) winner = entry;
  }

  return winner.color;
}

export function sampleForegroundColor(
  image: PixelBuffer,
  centerX: number,
  centerY: number,
  radius = 5,
): string {
  const x = Math.max(0, Math.min(image.width - 1, Math.round(centerX)));
  const y = Math.max(0, Math.min(image.height - 1, Math.round(centerY)));
  const sampleRadius = Math.max(0, Math.round(radius));
  const minX = Math.max(0, x - sampleRadius);
  const maxX = Math.min(image.width - 1, x + sampleRadius);
  const minY = Math.max(0, y - sampleRadius);
  const maxY = Math.min(image.height - 1, y + sampleRadius);
  const clicked = readPixel(image, x, y);
  const samples: Rgb[] = [];
  const perimeter: Rgb[] = [];

  for (let sampleY = minY; sampleY <= maxY; sampleY += 1) {
    for (let sampleX = minX; sampleX <= maxX; sampleX += 1) {
      const color = readPixel(image, sampleX, sampleY);
      samples.push(color);
      if (sampleX === minX || sampleX === maxX || sampleY === minY || sampleY === maxY) {
        perimeter.push(color);
      }
    }
  }

  const background = mostFrequentColor(perimeter.length > 0 ? perimeter : samples);
  const counts = new Map<string, { color: Rgb; count: number; contrast: number }>();
  for (const color of samples) {
    const key = colorKey(color);
    const entry = counts.get(key) ?? {
      color,
      count: 0,
      contrast: colorDistanceSquared(color, background),
    };
    entry.count += 1;
    counts.set(key, entry);
  }

  const entries = [...counts.values()];
  const supportedEntries = entries.filter(entry => entry.count >= 2);
  const candidates = supportedEntries.length > 0 ? supportedEntries : entries;
  const maxContrast = Math.max(...candidates.map(entry => entry.contrast));
  if (maxContrast === 0) return toHex(clicked[0], clicked[1], clicked[2]);

  // Anti-aliased edge pixels sit between the background and the solid glyph
  // color. Use the repeated color plateau nearest the contrast endpoint;
  // never return the clicked edge merely because it is almost solid.
  const foregroundThreshold = maxContrast * 0.995;
  const foreground = candidates
    .filter(entry => entry.contrast >= foregroundThreshold)
    .sort((first, second) => second.count - first.count || second.contrast - first.contrast)[0]
    .color;
  return toHex(foreground[0], foreground[1], foreground[2]);
}
