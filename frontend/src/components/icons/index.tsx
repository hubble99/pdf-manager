import type { ComponentType } from 'react';
import { FeatureGlyph } from './FeatureGlyph';
import { GLYPHS, type GlyphId } from './featureGlyphs';

/** The props every icon in the app accepts, so a feature glyph can stand in for a Lucide icon. */
export interface IconProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export type IconComponent = ComponentType<IconProps>;

function makeFeatureIcon(id: GlyphId): IconComponent {
  // The glyph has its own fixed stroke weights, so `strokeWidth` is accepted and ignored.
  const Icon: IconComponent = ({ size, className }) => <FeatureGlyph id={id} size={size} className={className} />;
  Icon.displayName = `FeatureIcon(${id})`;
  return Icon;
}

/** One brand icon per feature, keyed by the feature id. */
export const FEATURE_ICONS = Object.fromEntries(
  (Object.keys(GLYPHS) as GlyphId[]).map((id) => [id, makeFeatureIcon(id)]),
) as Record<GlyphId, IconComponent>;
