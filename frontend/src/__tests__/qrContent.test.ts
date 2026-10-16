import { describe, expect, it } from 'vitest';
import { normalizeQrContent } from '../utils/qrContent';

describe('normalizeQrContent', () => {
  it.each([
    ['google.com', 'https://google.com'],
    ['sbp.badanpangan.go.id', 'https://sbp.badanpangan.go.id'],
    ['www.example.com/path?q=1', 'https://www.example.com/path?q=1'],
    ['  example.org  ', 'https://example.org'],
  ])('adds https:// to the bare domain %s', (input, expected) => {
    expect(normalizeQrContent(input)).toBe(expected);
  });

  it.each([
    'https://sbp.badanpangan.go.id',
    'http://example.com',
    'mailto:someone@example.com',
    'tel:+62211234567',
    'WIFI:T:WPA;S:home;P:secret;;',
    'someone@example.com',
    'Hello world',
    'two.words here.com',
    'notadomain',
    '',
  ])('leaves %j exactly as typed', (input) => {
    expect(normalizeQrContent(input)).toBe(input);
  });
});
