import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import { Sidebar } from './components/layout/Sidebar';
import { MainContent } from './components/layout/MainContent';
import { MergePage } from './pages/MergePage';
import { ExtractPage } from './pages/ExtractPage';
import { CompressPage } from './pages/CompressPage';
import { ConverterPage } from './pages/ConverterPage';
import { PdfToWordPage } from './pages/PdfToWordPage';
import { HomePage } from './pages/HomePage';
import { DonationPage } from './pages/DonationPage';
import { QrBarcodePage } from './pages/QrBarcodePage';
import { SettingsPage } from './pages/SettingsPage';
import { OrganizePage } from './pages/OrganizePage';
import { ProtectPage } from './pages/ProtectPage';
import { checkHealth } from './api/client';
import { SplashScreen } from './components/SplashScreen';
import { isTauri } from './utils/tauriDialog';
import { ToastProvider } from './context/ToastContext';
import { FileProvider } from './context/FileContext';
import { ThemeProvider } from './context/ThemeContext';
import { LanguageProvider, SKIP_SPLASH_KEY } from './i18n/LanguageProvider';
import { ToastContainer } from './components/ToastContainer';
import { t } from './i18n';
type AppState = 'splash' | 'ready' | 'error';
type BackendStatus = 'checking' | 'online' | 'offline';

const EditCanvasPage = lazy(() =>
  import('./pages/EditCanvasPage').then((module) => ({ default: module.EditCanvasPage }))
);
const EditContentPage = lazy(() =>
  import('./pages/EditContentPage').then((module) => ({ default: module.EditContentPage }))
);

function RouteFallback() {
  return (
    <div className="page-body" role="status" aria-live="polite">
      {t('Loading PDF editor…')}
    </div>
  );
}

function BackendStatusBar({ status }: { status: BackendStatus }) {
  if (status === 'online') return null;

  const isChecking = status === 'checking';

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        background: isChecking ? 'var(--surface-container-high)' : 'var(--error-container)',
        borderBottom: `1px solid ${isChecking ? 'var(--outline-variant)' : 'rgba(255,180,171,0.3)'}`,
        padding: '6px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 12,
        color: isChecking ? 'var(--on-surface-variant)' : 'var(--error)',
        fontWeight: 500,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: isChecking ? 'var(--outline)' : 'var(--error)',
          flexShrink: 0,
          animation: isChecking ? 'pulse 1.5s infinite' : undefined,
        }}
      />
      {isChecking
        ? t('Connecting to Dokuwu backend...')
        : t('Backend offline — Start the Python server: cd backend && .venv\\Scripts\\uvicorn main:app --reload')}
    </div>
  );
}

export default function App() {
  // In browser/dev mode: skip splash (backend already running via uvicorn)
  // In Tauri production: show splash while sidecar boots up
  const [appState, setAppState] = useState<AppState>(() => {
    if (!isTauri()) return 'ready';
    // A language switch reloads the app while the backend is already running.
    try {
      if (window.sessionStorage.getItem(SKIP_SPLASH_KEY)) {
        window.sessionStorage.removeItem(SKIP_SPLASH_KEY);
        return 'ready';
      }
    } catch {
      // Fall through to the splash.
    }
    return 'splash';
  });
  const [backendStatus, setBackendStatus] = useState<BackendStatus>('checking');

  useEffect(() => {
    if (appState !== 'ready') return;

    let cancelled = false;

    const check = async () => {
      const ok = await checkHealth();
      if (!cancelled) setBackendStatus(ok ? 'online' : 'offline');
    };

    check();

    // Re-check every 10 seconds when offline
    const interval = setInterval(async () => {
      if (backendStatus !== 'online') {
        const ok = await checkHealth();
        if (!cancelled) setBackendStatus(ok ? 'online' : 'offline');
      }
    }, 10_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [appState, backendStatus]);

  // Show splash screen while Tauri sidecar boots
  if (appState === 'splash') {
    return (
      <SplashScreen
        onReady={() => setAppState('ready')}
        onError={() => setAppState('error')}
      />
    );
  }

  const topOffset = backendStatus !== 'online' ? 33 : 0;

  return (
    <ThemeProvider>
      <ToastProvider>
        <FileProvider>
          <LanguageProvider>
          <BrowserRouter>
            <BackendStatusBar status={backendStatus} />
          <div
            className="app-shell"
            style={{ marginTop: topOffset, height: `calc(100vh - ${topOffset}px)` }}
          >
            <Sidebar />
            <MainContent>
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/donation" element={<DonationPage />} />
                <Route path="/merge"         element={<MergePage />} />
                <Route path="/extract"       element={<ExtractPage />} />
                <Route path="/compress"      element={<CompressPage />} />
                <Route path="/converter"     element={<ConverterPage />} />
                <Route path="/pdf-to-word"   element={<PdfToWordPage />} />
                <Route path="/pdf-to-image"  element={<Navigate to="/converter" replace />} />
                <Route path="/image-to-pdf"  element={<Navigate to="/converter" replace />} />
                <Route path="/organize"      element={<OrganizePage />} />
                <Route path="/protect"       element={<ProtectPage />} />
                <Route path="/qr-barcode"    element={<QrBarcodePage />} />
                <Route
                  path="/edit-canvas"
                  element={(
                    <Suspense fallback={<RouteFallback />}>
                      <EditCanvasPage />
                    </Suspense>
                  )}
                />
                <Route
                  path="/edit-content"
                  element={(
                    <Suspense fallback={<RouteFallback />}>
                      <EditContentPage />
                    </Suspense>
                  )}
                />
                <Route path="/settings"      element={<SettingsPage />} />
              </Routes>
            </MainContent>
          </div>
          <ToastContainer />
          <style>{`
            @keyframes pulse {
              0%, 100% { opacity: 1; }
              50% { opacity: 0.3; }
            }
          `}</style>
        </BrowserRouter>
          </LanguageProvider>
      </FileProvider>
    </ToastProvider>
    </ThemeProvider>
  );
}
