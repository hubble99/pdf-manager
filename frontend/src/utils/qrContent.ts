const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const BARE_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#]\S*)?$/i;

/**
 * A QR code stores plain text, and a phone only opens it as a link when it
 * carries a scheme. "sbp.badanpangan.go.id" is read as text and searched for,
 * while "https://sbp.badanpangan.go.id" opens the site. A bare domain is
 * therefore stored with https://; anything else is left exactly as typed.
 */
export function normalizeQrContent(raw: string): string {
  const text = raw.trim();
  if (!text || /\s/.test(text) || HAS_SCHEME.test(text) || EMAIL.test(text)) return raw;
  return BARE_DOMAIN.test(text) ? `https://${text}` : raw;
}
