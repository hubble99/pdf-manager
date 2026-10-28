import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../context/ToastContext';
import { HomePage } from '../pages/HomePage';
import { DonationPage } from '../pages/DonationPage';
import { APP_DESCRIPTION, APP_NAME, APP_TAGLINE } from '../config/app';
import { FEATURE_GROUPS, FEATURES } from '../config/features';
import { DONATION, DONATION_TEXTS, QRIS_IS_PLACEHOLDER } from '../config/donation';

const { toastMock, openMock } = vi.hoisted(() => ({
  toastMock: vi.fn(), openMock: vi.fn(),
}));

vi.mock('../hooks/useToast', () => ({ useToast: () => ({ showToast: toastMock }) }));
vi.mock('../utils/openExternal', () => ({ openInSystemBrowser: openMock }));

const renderAt = (path: string, element: React.ReactElement) =>
  render(<MemoryRouter initialEntries={[path]}><ToastProvider>{element}</ToastProvider></MemoryRouter>);

describe('Home', () => {
  it('introduces the product from the shared config', () => {
    renderAt('/', <HomePage />);
    // The name appears in the page header and in the hero, both from the config.
    expect(screen.getAllByText(APP_NAME).length).toBeGreaterThanOrEqual(2);
    expect(document.querySelector('.home-hero-name')).toHaveTextContent(APP_NAME);
    // The tagline is also the page header's description, so scope the hero copy.
    expect(document.querySelector('.home-hero-tagline')).toHaveTextContent(APP_TAGLINE);
    expect(screen.getByText(APP_DESCRIPTION)).toBeInTheDocument();
  });

  it('does not describe the product as PDF-only', () => {
    expect(APP_DESCRIPTION.toLowerCase()).not.toContain('pdf only');
  });

  it('shows every feature grouped in the registry order', () => {
    renderAt('/', <HomePage />);
    // Each group heading is present, in order.
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(FEATURE_GROUPS.map((group) => group.label));

    for (const feature of FEATURES) {
      expect(document.getElementById(`home-card-${feature.id}`), feature.id).toBeTruthy();
    }
  });

  it('offers no quick actions or recent files', () => {
    renderAt('/', <HomePage />);
    const text = document.body.textContent?.toLowerCase() ?? '';
    expect(text).not.toContain('recent');
    expect(text).not.toContain('quick action');
  });

  it('writes nothing to storage when visited', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderAt('/', <HomePage />);
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('shows the donation teaser with one icon, the title, and one button', () => {
    renderAt('/', <HomePage />);
    const teaser = document.querySelector('.home-donation-teaser') as HTMLElement;
    expect(within(teaser).getByText('Support this app')).toBeInTheDocument();
    expect(teaser.querySelectorAll('svg')).toHaveLength(1);
    const buttons = within(teaser).getAllByRole('link');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute('href', '/donation');
  });

  it('opens a feature from its card', () => {
    renderAt('/', <HomePage />);
    expect(document.getElementById('home-card-merge')).toHaveAttribute('href', '/merge');
    expect(document.getElementById('home-card-organize')).toHaveAttribute('href', '/organize');
  });

  it('keeps the BETA badge on Edit Content and its tooltip', () => {
    renderAt('/', <HomePage />);
    const card = document.getElementById('home-card-edit-content') as HTMLElement;
    const badge = card.querySelector('.home-card-badge');
    expect(badge).toHaveTextContent('BETA');
    expect(badge).toHaveAttribute('title', 'Beta: this feature is still unstable.');
    // Every other card is free of the badge, PDF to Word included.
    expect((document.getElementById('home-card-pdf-to-word') as HTMLElement).querySelector('.home-card-badge')).toBeNull();
    expect(document.querySelectorAll('.home-card-badge')).toHaveLength(1);
  });

  it('names the canvas feature Canvas PDF everywhere', () => {
    renderAt('/', <HomePage />);
    expect(document.getElementById('home-card-edit-canvas')).toHaveTextContent('Canvas PDF');
    expect(document.body.textContent).not.toContain('Edit Canvas');
  });
});

describe('Donation page', () => {
  beforeEach(() => {
    toastMock.mockReset(); openMock.mockReset();
    openMock.mockResolvedValue(undefined);
  });

  it('shows the real bundled codes from local assets, never a remote URL', () => {
    renderAt('/donation', <DonationPage />);
    const qris = screen.getByAltText(DONATION_TEXTS.qrisAlt) as HTMLImageElement;
    const paypal = screen.getByAltText(DONATION_TEXTS.paypalAlt) as HTMLImageElement;

    expect(qris.getAttribute('src')).toBeTruthy();
    expect(paypal.getAttribute('src')).toBeTruthy();
    expect(QRIS_IS_PLACEHOLDER).toBe(false);
    expect(qris.getAttribute('src')).not.toMatch(/^https?:/);
    expect(paypal.getAttribute('src')).not.toMatch(/^https?:/);
  });

  it('shows one method at a time, starting with Indonesia, and switches by tab', () => {
    renderAt('/donation', <DonationPage />);
    const qrisPanel = document.getElementById('donation-panel-qris') as HTMLElement;
    const paypalPanel = document.getElementById('donation-panel-paypal') as HTMLElement;

    expect(screen.getByRole('tab', { name: /Indonesia/ })).toHaveAttribute('aria-selected', 'true');
    expect(qrisPanel).toBeVisible();
    expect(paypalPanel).not.toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: /International/ }));

    expect(screen.getByRole('tab', { name: /International/ })).toHaveAttribute('aria-selected', 'true');
    expect(paypalPanel).toBeVisible();
    expect(qrisPanel).not.toBeVisible();
  });

  it('names the recipient and the pre-payment check for both methods', () => {
    const { container } = renderAt('/donation', <DonationPage />);
    const names = [...container.querySelectorAll('.donation-recipient-name')].map((node) => node.textContent);
    expect(names).toEqual([
      `Recipient: ${DONATION.recipientName}`,
      `Recipient: ${DONATION.recipientName}`,
    ]);
    expect(screen.getAllByText(DONATION_TEXTS.recipientCheck)).toHaveLength(2);
    expect(screen.getByText(DONATION_TEXTS.safetyNote)).toBeInTheDocument();
    expect(document.body.textContent).toContain('github.com/hubble99/pdf-manager');
  });

  it('copies the exact PayPal link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderAt('/donation', <DonationPage />);
    fireEvent.click(document.getElementById('donation-copy') as HTMLButtonElement);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(DONATION.paypalUrl));
  });

  it('opens the PayPal link in the system browser', async () => {
    renderAt('/donation', <DonationPage />);
    const open = document.getElementById('donation-open') as HTMLButtonElement;
    expect(open).toBeEnabled();

    fireEvent.click(open);

    await waitFor(() => expect(openMock).toHaveBeenCalledWith(DONATION.paypalUrl));
    expect(openMock).toHaveBeenCalledTimes(1);
  });

  it('collects no card, account, or credential data', () => {
    const { container } = renderAt('/donation', <DonationPage />);
    expect(container.querySelectorAll('form, input, textarea, select')).toHaveLength(0);
    expect(container.querySelector('[type="password"]')).toBeNull();
  });
});
