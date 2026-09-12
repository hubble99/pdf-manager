import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';


describe('Edit Content feature isolation', () => {
  it('does not import Canvas or Fabric runtime ownership', () => {
    const sources = [
      '../pages/EditContentPage.tsx',
      '../features/edit-content/EditContentViewport.tsx',
      '../features/edit-content/api.ts',
    ].map((relativePath) => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8'));
    for (const source of sources) {
      expect(source).not.toMatch(/features\/edit-canvas|PageCanvas|from ['"]fabric|content_edit/);
    }
  });

  it('keeps Canvas and Content as independent destinations', () => {
    const [app, sidebar] = [
      '../App.tsx',
      '../components/layout/Sidebar.tsx',
    ].map((relativePath) => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8'));
    expect(app).toContain('path="/edit-canvas"');
    expect(app).toContain('path="/edit-content"');
    expect(sidebar).toContain("path: '/edit-canvas'");
    expect(sidebar).toContain("path: '/edit-content'");
  });
});
