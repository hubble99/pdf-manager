import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { applyLanguage, getLanguage, t, tn } from '../i18n';
import { ID } from '../i18n/id';

const SRC = path.resolve(__dirname, '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'i18n') sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function literal(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return literal(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literal(node.left);
    const right = literal(node.right);
    return left !== null && right !== null ? left + right : null;
  }
  return null;
}

function collectKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const add = (node: ts.Node | undefined) => {
      const value = node ? literal(node) : null;
      if (value !== null && !keys.has(value)) keys.set(value, path.relative(SRC, file));
    };
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === 't') add(node.arguments[0]);
        if (node.expression.text === 'tn') {
          add(node.arguments[1]);
          add(node.arguments[2]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return keys;
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n', () => {
  afterEach(() => applyLanguage('en'));

  it('has an Indonesian entry for every string used in the app', () => {
    const missing = [...collectKeys()].filter(([key]) => !(key in ID)).map(([key, file]) => `${file}: ${key}`);
    expect(missing).toEqual([]);
  });

  it('keeps the placeholders of every translation identical to its English text', () => {
    const broken = Object.entries(ID)
      .filter(([key, value]) => placeholders(key).join() !== placeholders(value).join())
      .map(([key]) => key);
    expect(broken).toEqual([]);
  });

  it('returns English by default and fills placeholders', () => {
    expect(getLanguage()).toBe('en');
    expect(t('Merge PDF')).toBe('Merge PDF');
    expect(t('Page {n}', { n: 3 })).toBe('Page 3');
  });

  it('translates when Indonesian is active and falls back to English for unknown text', () => {
    applyLanguage('id');
    expect(t('Settings')).toBe('Pengaturan');
    expect(t('Page {n}', { n: 3 })).toBe('Halaman 3');
    expect(t('Some text without an entry {n}', { n: 1 })).toBe('Some text without an entry 1');
  });

  it('picks the singular or plural form by count', () => {
    expect(tn(1, '{n} page', '{n} pages')).toBe('1 page');
    expect(tn(4, '{n} page', '{n} pages')).toBe('4 pages');
    applyLanguage('id');
    expect(tn(1, '{n} page', '{n} pages')).toBe('1 halaman');
    expect(tn(4, '{n} page', '{n} pages')).toBe('4 halaman');
  });
});
