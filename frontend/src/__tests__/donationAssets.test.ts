import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DONATION, DONATION_TEXTS, QRIS_IS_PLACEHOLDER } from '../config/donation';

/** Reads a repo file relative to this test file. */
const readRepoFile = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)));

const sha256 = (relative: string) =>
  createHash('sha256').update(readRepoFile(relative)).digest('hex');

describe('donation data and assets', () => {
  it('pins the exact PayPal destination', () => {
    expect(DONATION.paypalUrl).toBe('https://www.paypal.com/qrcodes/p2pqrc/VFBT2J9WJA3EY');
  });

  it('pins the recipient name shown for every method', () => {
    expect(DONATION.recipientName).toBe('Ramadhoni Nasri');
  });

  it('uses the real bundled codes', () => {
    expect(QRIS_IS_PLACEHOLDER).toBe(false);
    expect(DONATION.qrisImage).toBeTruthy();
    expect(DONATION.paypalImage).toBeTruthy();
  });

  it.each([
    ['../assets/donation-qris.jpeg', 'faf3204f210d0e1969464f8587ea36f7e541d07d55b0027f6d7e2fce4a6bcdad'],
    ['../assets/donation-paypal.jpeg', '44c68289c4f2d4202afd213f89400507411408361091c4bf822bd581db87831c'],
  ])('pins the SHA-256 of %s', (relative, expected) => {
    expect(sha256(relative)).toBe(expected);
  });

  it('states the required payment-safety guidance', () => {
    expect(DONATION_TEXTS.safetyNote).toBe(
      'PDF Manager never asks for payment details, or for donations by email or '
      + 'chat. The only official source is github.com/hubble99/pdf-manager.',
    );
  });
});

describe('Tauri opener scope', () => {
  const capability = JSON.parse(
    readRepoFile('../../src-tauri/capabilities/default.json').toString('utf8'),
  ) as { permissions: unknown[] };

  it('allows exactly the configured PayPal URL and no default opener', () => {
    const openerPermissions = capability.permissions.filter(
      (permission) => typeof permission === 'object'
        && permission !== null
        && String((permission as { identifier?: unknown }).identifier).startsWith('opener:'),
    );

    expect(openerPermissions).toEqual([
      { identifier: 'opener:allow-open-url', allow: [{ url: DONATION.paypalUrl }] },
    ]);
    expect(capability.permissions).not.toContain('opener:default');
    expect(capability.permissions).not.toContain('opener:allow-default-urls');
  });
});
