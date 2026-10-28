import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../i18n/LanguageProvider';
import { ThemeProvider } from '../context/ThemeContext';
import { LicensesPage } from '../pages/LicensesPage';
import { SettingsPage } from '../pages/SettingsPage';
import { ToastProvider } from '../context/ToastContext';

const repoRoot = resolve(__dirname, '../../..');
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8');

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <MemoryRouter>
      <LanguageProvider>
        <ThemeProvider>
          <ToastProvider>{ui}</ToastProvider>
        </ThemeProvider>
      </LanguageProvider>
    </MemoryRouter>,
  );
}

describe('legal notices', () => {
  it('ships the AGPL text and the generated third-party list in the app, in step with the repo root', () => {
    expect(read('frontend/src/assets/legal/LICENSE.txt').trim()).toBe(read('LICENSE').trim());
    expect(read('frontend/src/assets/legal/THIRD-PARTY-NOTICES.txt')).toBe(read('THIRD-PARTY-NOTICES.txt'));
    expect(read('LICENSE')).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
    expect(read('THIRD-PARTY-NOTICES.txt')).toContain('MuPDF');
    expect(read('THIRD-PARTY-NOTICES.txt')).toContain('PDFium');
  });

  it('declares the same license in every manifest', () => {
    expect(JSON.parse(read('frontend/package.json')).license).toBe('AGPL-3.0-or-later');
    for (const manifest of [
      'frontend/src-tauri/Cargo.toml',
      'native/dokuwu-core/Cargo.toml',
      'native/edit-content-engine/Cargo.toml',
    ]) {
      expect(read(manifest)).toContain('license = "AGPL-3.0-or-later"');
    }
  });

  it('shows the legal notice in Settings > About', () => {
    renderWithProviders(<SettingsPage />);
    expect(document.getElementById('settings-legal-notice')).toHaveTextContent('ABSOLUTELY NO WARRANTY');
    expect(document.getElementById('settings-licenses')).toHaveAttribute('href', '/licenses');
  });

  it('opens the license texts on the Licenses page', async () => {
    renderWithProviders(<LicensesPage />);
    await waitFor(() => expect(screen.getByRole('tabpanel')).toHaveTextContent('GNU AFFERO GENERAL PUBLIC LICENSE'));
    screen.getByRole('tab', { name: 'Third-party software' }).click();
    await waitFor(() => expect(screen.getByRole('tabpanel')).toHaveTextContent('MuPDF'));
  });
});
