import { isTheme } from '../context/ThemeContext.context';
import { readFileSync } from 'node:fs';

const stylesheet = readFileSync('src/index.css', 'utf8');

describe('theme validation', () => {
  it.each(['dark', 'dusty-rose', 'steel-blue'])('accepts %s', (theme) => {
    expect(isTheme(theme)).toBe(true);
  });

  it.each([null, '', 'blue', 'theme-name'])('rejects %s', (theme) => {
    expect(isTheme(theme)).toBe(false);
  });
});

describe('canvas theme tokens', () => {
  it.each([
    ['dusty-rose', '#F6E8E8', '#5C3333'],
    ['steel-blue', '#E8EEF8', '#395886'],
  ])('overrides Canvas tokens for %s', (theme, canvasBackground, selectionBorder) => {
    const themeStart = stylesheet.indexOf(`[data-theme="${theme}"]`);
    const themeBlock = stylesheet.slice(themeStart, stylesheet.indexOf('\n}', themeStart));

    expect(themeBlock).toContain(`--canvas-bg:                ${canvasBackground};`);
    expect(themeBlock).toContain(`--canvas-selection-border:  ${selectionBorder};`);
  });
});

describe('accent text tokens', () => {
  it.each([
    ['dark', ':root'],
    ['dusty-rose', '[data-theme="dusty-rose"]'],
    ['steel-blue', '[data-theme="steel-blue"]'],
  ])('defines --on-accent for %s', (_theme, selector) => {
    const blockStart = stylesheet.indexOf(selector);
    const block = stylesheet.slice(blockStart, stylesheet.indexOf('\n}', blockStart));

    expect(block).toMatch(/--on-accent:\s*#[0-9A-Fa-f]{6};/);
  });
});
