import { useCallback, useState } from 'react';
import { Copy, ExternalLink, Flag, Globe } from 'lucide-react';
import { FEATURE_ICONS } from '../components/icons';
import { PageHeader, Tabs } from '../components/ui';
import { useToast } from '../hooks/useToast';
import { DONATION, DONATION_TEXTS, QRIS_IS_PLACEHOLDER } from '../config/donation';
import { openInSystemBrowser } from '../utils/openExternal';
import { t } from '../i18n';

type Method = 'qris' | 'paypal';

/**
 * The donation page shows the real bundled codes and the recipient name for each
 * method. It collects nothing: there is no form, no card field, and no account
 * or credential input anywhere on this screen. The PayPal action opens the one
 * fixed URL in the system browser.
 */
export function DonationPage() {
  const { showToast } = useToast();
  const [isOpening, setIsOpening] = useState(false);
  const [method, setMethod] = useState<Method>('qris');

  const copyLink = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(DONATION.paypalUrl);
      } else {
        // Selection-based fallback for a WebView that is not a secure context.
        const field = document.createElement('textarea');
        field.value = DONATION.paypalUrl;
        document.body.appendChild(field);
        field.select();
        document.execCommand('copy');
        document.body.removeChild(field);
      }
      showToast({ type: 'success', title: DONATION_TEXTS.copied });
    } catch {
      showToast({ type: 'error', title: t('Could not copy'), message: t('Copy the link manually.') });
    }
  }, [showToast]);

  const openPaypal = useCallback(async () => {
    setIsOpening(true);
    try {
      await openInSystemBrowser(DONATION.paypalUrl);
    } catch {
      showToast({ type: 'error', title: t('Could not open the link') });
    } finally {
      setIsOpening(false);
    }
  }, [showToast]);

  const recipient = (
    <div className="donation-recipient">
      <p className="donation-recipient-name">
        {DONATION_TEXTS.recipientLabel}: <strong>{DONATION.recipientName}</strong>
      </p>
      <p className="donation-recipient-check">{DONATION_TEXTS.recipientCheck}</p>
    </div>
  );

  return (
    <div className="feature-page">
      <PageHeader icon={FEATURE_ICONS.donation} title={DONATION_TEXTS.title} description={DONATION_TEXTS.summary} />

      <Tabs
        ariaLabel={t('Donation method')}
        value={method}
        onChange={setMethod}
        items={[
          { value: 'qris', id: 'donation-tab-qris', controls: 'donation-panel-qris', label: t('Indonesia'), icon: <Flag size={15} aria-hidden="true" /> },
          { value: 'paypal', id: 'donation-tab-paypal', controls: 'donation-panel-paypal', label: t('International'), icon: <Globe size={15} aria-hidden="true" /> },
        ]}
      />

      <div className="page-body">
        <div className="donation-col">
          {/* Both panels stay in the document; only the chosen one is shown. */}
          <section
            id="donation-panel-qris"
            role="tabpanel"
            aria-labelledby="donation-tab-qris"
            hidden={method !== 'qris'}
            className="card card--flush donation-card"
          >
            <div className="donation-visual">
              <img className="donation-qris" src={DONATION.qrisImage} alt={DONATION_TEXTS.qrisAlt} />
            </div>
            <div className="donation-info">
              <h2 className="donation-panel-title">{DONATION_TEXTS.domesticTitle}</h2>
              {recipient}
              {QRIS_IS_PLACEHOLDER && (
                <p className="donation-note" role="note">{DONATION_TEXTS.qrisPlaceholderNote}</p>
              )}
              <p className="donation-hint">{DONATION_TEXTS.domesticHint}</p>
              <ol className="donation-steps">
                <li>{t('Open your e-wallet or banking app')}</li>
                <li>{t('Scan the QR code')}</li>
                <li>{t('Enter an amount and confirm')}</li>
              </ol>
            </div>
          </section>

          <section
            id="donation-panel-paypal"
            role="tabpanel"
            aria-labelledby="donation-tab-paypal"
            hidden={method !== 'paypal'}
            className="card card--flush donation-card"
          >
            <div className="donation-visual">
              <img className="donation-qris" src={DONATION.paypalImage} alt={DONATION_TEXTS.paypalAlt} />
            </div>
            <div className="donation-info">
              <h2 className="donation-panel-title">{DONATION_TEXTS.internationalTitle}</h2>
              {recipient}
              <p className="donation-hint">{DONATION_TEXTS.internationalHint}</p>
              <p className="donation-value" id="donation-value">{DONATION.paypalUrl}</p>
              <div className="donation-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  id="donation-copy"
                  onClick={() => void copyLink()}
                >
                  <Copy size={13} aria-hidden="true" /> {DONATION_TEXTS.copy}
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  id="donation-open"
                  onClick={() => void openPaypal()}
                  disabled={isOpening}
                >
                  <ExternalLink size={13} aria-hidden="true" /> {DONATION_TEXTS.open}
                </button>
              </div>
              <small className="hint">{t('Opens PayPal in your system browser.')}</small>
            </div>
          </section>

          <p className="donation-safety" role="note">
            {DONATION_TEXTS.safetyNote}
          </p>
        </div>
      </div>
    </div>
  );
}
