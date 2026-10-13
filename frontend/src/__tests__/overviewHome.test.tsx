import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../context/ToastContext';
import { HomePage } from '../pages/HomePage';
import { DonationPage } from '../pages/DonationPage';
import { APP_DESCRIPTION, APP_NAME, APP_TAGLINE } from '../config/app';
import { FEATURE_GROUPS, FEATURES } from '../config/features';
import { DONATION_TEXTS, QRIS_IS_PLACEHOLDER } from '../config/donation';

const { getMock, postMock, toastMock } = vi.hoisted(() => ({
  getMock: vi.fn(), postMock: vi.fn(), toastMock: vi.fn(),
}));

vi.mock('../api/client', () => ({ default: { get: getMock, post: postMock } }));
vi.mock('../hooks/useToast', () => ({ useToast: () => ({ showToast: toastMock }) }));

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
});

describe('Donation page', () => {
  beforeEach(() => {
    getMock.mockReset(); postMock.mockReset(); toastMock.mockReset();
    getMock.mockResolvedValue({ data: { status: 'success', data: { value: '', is_placeholder: true, can_open: false } } });
    postMock.mockResolvedValue({ data: { status: 'success' } });
  });

  it('renders the bundled QRIS image with no network', async () => {
    renderAt('/donation', <DonationPage />);
    const image = screen.getByAltText('QRIS payment code') as HTMLImageElement;
    expect(image.getAttribute('src')).toBeTruthy();
    expect(QRIS_IS_PLACEHOLDER).toBe(true);
    expect(screen.getByText(DONATION_TEXTS.qrisPlaceholderNote)).toBeInTheDocument();
  });

  it('disables both actions while the value is a placeholder', async () => {
    renderAt('/donation', <DonationPage />);
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(document.getElementById('donation-open')).toBeDisabled();
    expect(document.getElementById('donation-copy')).toBeDisabled();
    expect(screen.getByText(DONATION_TEXTS.placeholderNote)).toBeInTheDocument();
  });

  it('copies an email value but keeps opening disabled', async () => {
    getMock.mockResolvedValue({ data: { status: 'success', data: { value: 'someone@example.com', is_placeholder: false, can_open: false } } });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderAt('/donation', <DonationPage />);
    await waitFor(() => expect(screen.getByText('someone@example.com')).toBeInTheDocument());

    expect(document.getElementById('donation-open')).toBeDisabled();
    const copy = document.getElementById('donation-copy') as HTMLButtonElement;
    expect(copy).toBeEnabled();
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('someone@example.com'));
  });

  it('enables opening only for a configured https link, and opens without a destination', async () => {
    getMock.mockResolvedValue({ data: { status: 'success', data: { value: 'https://paypal.me/someone', is_placeholder: false, can_open: true } } });
    renderAt('/donation', <DonationPage />);

    const open = document.getElementById('donation-open') as HTMLButtonElement;
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    // The request carries no destination: the backend opens the configured link.
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/api/v1/settings/open-donation'));
    expect(JSON.stringify(postMock.mock.calls)).not.toContain('paypal.me');
  });
});
