import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('Edit Canvas stable scope', () => {
  it('does not ship the legacy selectable-text runtime path', () => {
    const sources = [
      '../pages/EditCanvasPage.tsx',
      '../components/PageCanvas.tsx',
      '../types/canvas.ts',
    ].map((relativePath) => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8'));

    for (const source of sources) {
      expect(source).not.toMatch(/\b(?:edit_text|content_edit)\b|\/edit-canvas\/text-structure|Native Text|Edit Text/);
    }
  });
});
