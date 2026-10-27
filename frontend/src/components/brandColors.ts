/**
 * Recolours the logo for a theme whose palette would clash with its blue.
 *
 * Only the Dusty Rose theme needs this. Every colour of the artwork keeps its lightness and
 * (nearly) its saturation; the hue moves, from the logo's cyan-to-indigo range into a coral-to-orchid
 * range, so the gradients, shading and the face stay exactly as drawn. Greys and whites are
 * left alone. (A CSS `hue-rotate` filter was tried first and turned the dark blues muddy brown.)
 */
import type { Theme } from '../context/ThemeContext.context';

const SOURCE_FROM = 150;
const SOURCE_TO = 270;
const ROSE_AT_FROM = 352;
const ROSE_SPAN = 36;
/** Dusty Rose is a muted palette, so the recoloured logo is calmer than the vivid blue original. */
const ROSE_SATURATION = 0.72;

function shiftHue(hue: number): number {
  if (hue < SOURCE_FROM || hue > SOURCE_TO) return hue;
  const t = (hue - SOURCE_FROM) / (SOURCE_TO - SOURCE_FROM);
  return (ROSE_AT_FROM - t * ROSE_SPAN + 360) % 360;
}

function recolorHex(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 0.06) return hex;

  const s = (d / (1 - Math.abs(2 * l - 1))) * ROSE_SATURATION;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;

  const nh = shiftHue(h);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((nh / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] =
    nh < 60 ? [c, x, 0] : nh < 120 ? [x, c, 0] : nh < 180 ? [0, c, x] : nh < 240 ? [0, x, c] : nh < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r1)}${to(g1)}${to(b1)}`;
}

/** The artwork without its provenance metadata, which only bloats the inlined DOM. */
export function stripMetadata(svg: string): string {
  return svg.replace(/<metadata>[\s\S]*?<\/metadata>/, '');
}

/** The logo SVG for a theme: unchanged for every theme except Dusty Rose. */
export function themedLogoSvg(svg: string, theme: Theme): string {
  const clean = stripMetadata(svg);
  if (theme !== 'dusty-rose') return clean;
  return clean.replace(/#[0-9a-fA-F]{6}\b/g, recolorHex);
}
