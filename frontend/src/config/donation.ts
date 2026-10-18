/**
 * Donation content and assets, in one place.
 *
 * Everything a payment surface needs lives here: the two bundled QR images, the
 * exact PayPal destination, and the recipient name shown for each method.
 *
 * Hard rules for this module:
 * - the images are imported from `assets/`, so they are committed and bundled
 *   and are never fetched from a remote URL;
 * - `paypalUrl` is a fixed constant; no URL is ever built from user input and no
 *   query parameters are added;
 * - the Tauri opener capability allows exactly `paypalUrl` and nothing else, so
 *   changing the URL here requires the same change in
 *   `frontend/src-tauri/capabilities/default.json`;
 * - the app never collects card, account, or credential data. This page only
 *   displays a code and a link.
 *
 * `donationAssets.test.ts` pins the URL, the recipient name, both image hashes,
 * and the capability scope, so any change fails CI.
 */
import { APP_SOURCE_URL } from './app';
import { t } from '../i18n';
import paypalImage from '../assets/donation-paypal.jpeg';
import qrisImage from '../assets/donation-qris.jpeg';

export interface DonationDetails {
  /** The only payment destination the app may open. */
  paypalUrl: string;
  /** The name the payer must see in their payment app before confirming. */
  recipientName: string;
  /** Bundled QRIS code (Indonesia). */
  qrisImage: string;
  /** Bundled PayPal code (international). */
  paypalImage: string;
}

export const DONATION: DonationDetails = {
  paypalUrl: 'https://www.paypal.com/qrcodes/p2pqrc/VFBT2J9WJA3EY',
  recipientName: 'Ramadhoni Nasri',
  qrisImage,
  paypalImage,
};

/** False now that the bundled images are the real codes. */
export const QRIS_IS_PLACEHOLDER = false;

/** The official source, without the scheme, as it appears in safety copy. */
const OFFICIAL_SOURCE_HOST = APP_SOURCE_URL.replace(/^https?:\/\//, '');

export const DONATION_TEXTS = {
  title: t('Support this app'),
  summary: t('This app is free to use. Donations are completely voluntary and help keep development going.'),
  domesticTitle: t('Indonesia - QRIS'),
  domesticHint: t('Scan with any QRIS-capable app, such as ShopeePay or your bank app.'),
  internationalTitle: t('International - PayPal'),
  internationalHint: t('Scan the code with the PayPal app, or open the link below.'),
  recipientLabel: t('Recipient'),
  recipientCheck: t('Before you pay, check that your payment app shows this name.'),
  safetyNote: t(
    'Dokuwu never asks for payment details, or for donations by email or chat. The only official source is {host}.',
    { host: OFFICIAL_SOURCE_HOST },
  ),
  copy: t('Copy link'),
  open: t('Open PayPal'),
  copied: t('Link copied to the clipboard.'),
  qrisPlaceholderNote: t('Placeholder image - the real QRIS code will be added later.'),
  qrisAlt: t('QRIS payment code'),
  paypalAlt: t('PayPal payment QR code'),
};
