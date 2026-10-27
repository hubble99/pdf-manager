import { lazy, Suspense, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import { Sidebar } from './components/layout/Sidebar';
import { LeaveGuardProvider } from './context/LeaveGuard';
import { MainContent } from './components/layout/MainContent';
import { MergePage } from './pages/MergePage';
import { ExtractPage } from './pages/ExtractPage';
import { CompressPage } from './pages/CompressPage';
import { ConverterPage } from './pages/ConverterPage';
import { PdfToWordPage } from './pages/PdfToWordPage';
import { ImageFormatPage } from './pages/ImageFormatPage';
import { PhotoCompressPage } from './pages/PhotoCompressPage';
import { HomePage } from './pages/HomePage';
import { DonationPage } from './pages/DonationPage';
import { QrBarcodePage } from './pages/QrBarcodePage';
import { SettingsPage } from './pages/SettingsPage';
import { OrganizePage } from './pages/OrganizePage';
import { ProtectPage } from './pages/ProtectPage';
import { SplashScreen } from './components/SplashScreen';
import { isTauri } from './utils/tauriDialog';
import { ToastProvider } from './context/ToastContext';
import { FileProvider } from './context/FileContext';
import { ThemeProvider } from './context/ThemeContext';
import { LanguageProvider, SKIP_SPLASH_KEY } from './i18n/LanguageProvider';
import { ToastContainer } from './components/ToastContainer';
import { t } from './i18n';
type AppState = 'splash' | 'ready' | 'error';

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

export default function App() {
  // In a browser tab (tests, design work) there is no native core: skip the splash.
  // In the app: show the splash until the native core answers.
  const [appState, setAppState] = useState<AppState>(() => {
    if (!isTauri()) return 'ready';
    // A language switch reloads the app while the core is already running.
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
  // Show the splash screen until the native core is ready
  if (appState === 'splash') {
    return (
      <SplashScreen
        onReady={() => setAppState('ready')}
        onError={() => setAppState('error')}
      />
    );
  }

  return (
    <ThemeProvider>
      <ToastProvider>
        <FileProvider>
          <LanguageProvider>
          <BrowserRouter>
          <LeaveGuardProvider>
          <div className="app-shell">
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
                <Route path="/image-format"  element={<ImageFormatPage />} />
                <Route path="/photo-compress" element={<PhotoCompressPage />} />
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
          </LeaveGuardProvider>
        </BrowserRouter>
          </LanguageProvider>
      </FileProvider>
    </ToastProvider>
    </ThemeProvider>
  );
}
