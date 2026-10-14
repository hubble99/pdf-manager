import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThemeProvider } from '../context/ThemeContext';
import { ToastProvider } from '../context/ToastContext';
import { SettingsPage } from '../pages/SettingsPage';
import { APP_VERSION } from '../config/app';

function renderSettings() {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <ToastProvider>
          <SettingsPage />
        </ToastProvider>
      </ThemeProvider>
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
});
