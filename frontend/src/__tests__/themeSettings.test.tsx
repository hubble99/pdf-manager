import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../context/ThemeContext';
import { LanguageProvider } from '../i18n/LanguageProvider';
import { ToastProvider } from '../context/ToastContext';
import { SettingsPage } from '../pages/SettingsPage';
import { APP_VERSION } from '../config/app';
import { applyLanguage } from '../i18n';

function renderSettings() {
  return render(
    <MemoryRouter>
      <LanguageProvider>
        <ThemeProvider>
          <ToastProvider>
            <SettingsPage />
          </ToastProvider>
        </ThemeProvider>
      </LanguageProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('Settings appearance', () => {
  it('offers the four themes with Light as the default', () => {
    renderSettings();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('id'))).toEqual([
      'theme-light', 'theme-dark', 'theme-dusty-rose', 'theme-steel-blue',
    ]);
    expect(document.getElementById('theme-light')).toHaveAttribute('aria-checked', 'true');
    // The reference's System card is illustrative; the app never had one.
    expect(screen.queryByText('System')).not.toBeInTheDocument();
  });

  it('applies and remembers a chosen theme', () => {
    renderSettings();
    fireEvent.click(document.getElementById('theme-dark') as HTMLButtonElement);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('app_theme')).toBe('dark');
  });

  it('reports the version from the single package source', () => {
    renderSettings();
    expect(document.body.textContent).toContain(`v${APP_VERSION}`);
  });

  it('describes the output list as session-only', () => {
    renderSettings();
    expect(screen.getByText(/clears when you close the app/i)).toBeInTheDocument();
  });

  describe('language', () => {
    const originalLocation = window.location;
    afterEach(() => {
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    });

    it('offers English and Indonesian, saves the choice and reloads', () => {
      const reload = vi.fn();
      Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, reload } });
      renderSettings();
      expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(screen.getByRole('button', { name: 'Bahasa Indonesia' }));
      expect(localStorage.getItem('app_language')).toBe('id');
      expect(reload).toHaveBeenCalledTimes(1);
      localStorage.removeItem('app_language');
      applyLanguage('en');
    });

    it('no longer offers an output folder', () => {
      renderSettings();
      expect(screen.queryByText(/output folder/i)).not.toBeInTheDocument();
    });
  });
});
