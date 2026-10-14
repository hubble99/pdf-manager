import { isTauri } from './tauriDialog';

/**
 * Opens an absolute `https` URL in the system browser.
 *
 * Safety contract:
 * - the caller must pass a fixed constant from `config/donation.ts`; no URL is
 *   ever built from user input and no parameter is appended here;
 * - in the desktop app the Tauri opener plugin is used, which hands the URL to
 *   the system browser instead of an in-app webview. The capability allows
 *   exactly one URL, so anything else is refused by the shell, not just by this
 *   function;
 * - in browser/dev mode a new tab is opened with `noopener,noreferrer`;
 * - anything that is not `https` is rejected here as a second line of defense.
 */
export async function openInSystemBrowser(url: string): Promise<void> {
  if (!url.startsWith('https://')) {
    throw new Error('Only https links can be opened.');
  }

  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
    return;
  }

  window.open(url, '_blank', 'noopener,noreferrer');
}
