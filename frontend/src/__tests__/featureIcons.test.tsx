import { readFileSync } from 'node:fs';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FEATURE_ICONS } from '../components/icons';
import { GLYPHS } from '../components/icons/featureGlyphs';
import { FEATURES } from '../config/features';

describe('feature icons', () => {
  it('gives every feature its own brand glyph', () => {
    for (const feature of FEATURES) {
      expect(GLYPHS, feature.id).toHaveProperty(feature.id);
      expect(feature.icon, feature.id).toBe(FEATURE_ICONS[feature.id as keyof typeof FEATURE_ICONS]);
    }
  });

  it('renders at the requested size and hides itself from assistive tech', () => {
    const Icon = FEATURE_ICONS.merge;
    const { container } = render(<Icon size={20} className="nav-item-icon" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('20');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.classList.contains('nav-item-icon')).toBe(true);
  });

  it('keeps gradient ids unique when the same glyph appears twice', () => {
    const Icon = FEATURE_ICONS.protect;
    const { container } = render(<><Icon /><Icon /></>);
    const ids = [...container.querySelectorAll('linearGradient')].map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('recolours the sheet for the Dusty Rose theme instead of staying blue', () => {
    const css = readFileSync('src/components/icons/feature-glyph.css', 'utf8');
    const block = css.slice(css.indexOf('[data-theme="dusty-rose"]'));
    for (const name of ['back-0', 'back-1', 'back-2', 'front-0', 'front-1', 'front-2', 'front-3', 'flap-0', 'flap-1']) {
      expect(block, name).toContain(`--fg-${name}:`);
    }
  });
});
