/**
 * Donation content, in one place.
 *
 * The QRIS image ships with the app so the page works offline. The payment value
 * is deliberately NOT here: the backend holds it, because the open action may
 * only ever open the configured destination and can only enforce that where the
 * destination lives. The page reads it from `/api/v1/settings/donation`.
 */
import qrisPlaceholder from '../assets/donation-qris-placeholder.png';

export const QRIS_IMAGE = qrisPlaceholder;

/** True while the bundled image is still the generated placeholder. */
export const QRIS_IS_PLACEHOLDER = true;

export const DONATION_TEXTS = {
  title: 'Support this app',
  summary:
    'This app is free to use. Donations are completely voluntary and help keep '
    + 'development going.',
  domesticTitle: 'Indonesia - QRIS',
  domesticHint: 'Scan with any QRIS-capable app, such as ShopeePay or your bank app.',
  internationalTitle: 'International - PayPal',
  copy: 'Copy',
  open: 'Open PayPal',
  placeholderNote: 'Not configured yet. The value will be added in a later update.',
  qrisPlaceholderNote: 'Placeholder image - the real QRIS code will be added later.',
  copied: 'Copied to the clipboard.',
};
