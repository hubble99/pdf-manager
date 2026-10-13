import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Heart } from 'lucide-react';
import apiClient from '../api/client';
import { PageHeader } from '../components/ui';
import { useToast } from '../hooks/useToast';
import { DONATION_TEXTS, QRIS_IMAGE, QRIS_IS_PLACEHOLDER } from '../config/donation';

interface DonationState {
  value: string;
  is_placeholder: boolean;
  can_open: boolean;
}

export function DonationPage() {
  const { showToast } = useToast();
  const [state, setState] = useState<DonationState>({ value: '', is_placeholder: true, can_open: false });
  const [isOpening, setIsOpening] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<{ status: string; data: DonationState }>('/api/v1/settings/donation')
      .then((response) => { if (!cancelled) setState(response.data.data); })
      .catch(() => { /* stays at the placeholder state */ });
    return () => { cancelled = true; };
  }, []);

  const copyValue = useCallback(async () => {
    // The preferred path, with a selection-based fallback for a WebView that is
    // not treated as a secure context.
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(state.value);
      } else {
        const field = document.createElement('textarea');
        field.value = state.value;
        document.body.appendChild(field);
        field.select();
        document.execCommand('copy');
        document.body.removeChild(field);
      }
      showToast({ type: 'success', title: DONATION_TEXTS.copied });
    } catch {
      showToast({ type: 'error', title: 'Could not copy', message: 'Copy the value manually.' });
    }
  }, [showToast, state.value]);

  const openValue = useCallback(async () => {
    setIsOpening(true);
    try {
      await apiClient.post('/api/v1/settings/open-donation');
    } catch {
      showToast({ type: 'error', title: 'Could not open the link' });
    } finally {
      setIsOpening(false);
    }
  }, [showToast]);

  return (
    <div className="feature-page">
      <PageHeader icon={Heart} title={DONATION_TEXTS.title} description={DONATION_TEXTS.summary} />

      <div className="page-body">
        <div className="donation-panels">
          <section className="card donation-panel" aria-label={DONATION_TEXTS.domesticTitle}>
            <h2 className="donation-panel-title">{DONATION_TEXTS.domesticTitle}</h2>
            <img className="donation-qris" src={QRIS_IMAGE} alt="QRIS payment code" />
            {QRIS_IS_PLACEHOLDER && (
              <p className="donation-note" role="note">{DONATION_TEXTS.qrisPlaceholderNote}</p>
            )}
            <p className="donation-hint">{DONATION_TEXTS.domesticHint}</p>
          </section>

          <section className="card donation-panel" aria-label={DONATION_TEXTS.internationalTitle}>
            <h2 className="donation-panel-title">{DONATION_TEXTS.internationalTitle}</h2>
            {state.is_placeholder ? (
              <p className="donation-note" role="note">{DONATION_TEXTS.placeholderNote}</p>
            ) : (
              <p className="donation-value" id="donation-value">{state.value}</p>
            )}
            <div className="donation-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                id="donation-copy"
                onClick={() => void copyValue()}
                disabled={state.is_placeholder || !state.value}
              >
                <Copy size={13} aria-hidden="true" /> {DONATION_TEXTS.copy}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                id="donation-open"
                onClick={() => void openValue()}
                disabled={!state.can_open || isOpening}
                title={state.can_open ? undefined : 'Available once a payment link is configured'}
              >
                <ExternalLink size={13} aria-hidden="true" /> {DONATION_TEXTS.open}
              </button>
            </div>
            {state.value && !state.can_open && (
              <p className="donation-hint">
                <Check size={12} aria-hidden="true" /> Copy the value above; opening needs a payment link.
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
