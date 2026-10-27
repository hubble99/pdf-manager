import { useId } from 'react';
import { GLYPHS, type GlyphId } from './featureGlyphs';
import './feature-glyph.css';

interface FeatureGlyphProps {
  id: GlyphId;
  size?: number;
  className?: string;
}

const SHEET = 'M7 2.5h7.2l5.3 5.3V19a2.5 2.5 0 0 1-2.5 2.5H7A2.5 2.5 0 0 1 4.5 19V5A2.5 2.5 0 0 1 7 2.5Z';
const FLAP = 'M14.2 2.5l5.3 5.3h-3.3a2 2 0 0 1-2-2z';
const FRAME = 'M6 3.5h12A2.5 2.5 0 0 1 20.5 6v12a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 18V6A2.5 2.5 0 0 1 6 3.5Z';
const TILE = 'M6.5 3h11A3.5 3.5 0 0 1 21 6.5v11a3.5 3.5 0 0 1-3.5 3.5h-11A3.5 3.5 0 0 1 3 17.5v-11A3.5 3.5 0 0 1 6.5 3Z';

/**
 * A feature icon drawn in the Dokuwu logo's language: a rounded document sheet with a
 * folded corner (or a picture frame for image tools) carrying one emblem.
 */
export function FeatureGlyph({ id, size = 24, className }: FeatureGlyphProps) {
  const uid = useId().replace(/:/g, '');
  const glyph = GLYPHS[id];
  const base = glyph.base === 'sheet' ? SHEET : glyph.base === 'frame' ? FRAME : TILE;

  return (
    <svg
      className={`feature-glyph ${className ?? ''}`}
      width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
    >
      <defs>
        <linearGradient id={`${uid}-back`} x1="0" y1="2.5" x2="0" y2="21.5" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: 'var(--fg-back-0, #22c2dc)' }} />
          <stop offset=".45" style={{ stopColor: 'var(--fg-back-1, #1f5cc0)' }} />
          <stop offset="1" style={{ stopColor: 'var(--fg-back-2, #101f8a)' }} />
        </linearGradient>
        <linearGradient id={`${uid}-front`} x1="0" y1="2.5" x2="0" y2="21.5" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: 'var(--fg-front-0, #8fe8f0)' }} />
          <stop offset=".3" style={{ stopColor: 'var(--fg-front-1, #4fb6ea)' }} />
          <stop offset=".7" style={{ stopColor: 'var(--fg-front-2, #3a7be0)' }} />
          <stop offset="1" style={{ stopColor: 'var(--fg-front-3, #3a56d0)' }} />
        </linearGradient>
        <linearGradient id={`${uid}-flap`} x1="14" y1="2.5" x2="19.5" y2="8" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: 'var(--fg-flap-0, #c8f3f6)' }} />
          <stop offset="1" style={{ stopColor: 'var(--fg-flap-1, #9ee6ee)' }} />
        </linearGradient>
        <linearGradient id={`${uid}-rim`} x1="4.5" y1="2.5" x2="8" y2="12" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity=".9" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {glyph.base === 'sheet' && (
        <path d={SHEET} transform="translate(-1.6 .4)" fill={`url(#${uid}-back)`} />
      )}
      <path d={base} fill={`url(#${uid}-front)`} />
      <path d={base} fill="none" stroke={`url(#${uid}-rim)`} strokeWidth=".9" />
      {glyph.base === 'sheet' && <path d={FLAP} fill={`url(#${uid}-flap)`} />}
      <g className="feature-glyph-emblem" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {glyph.emblem}
      </g>
    </svg>
  );
}
