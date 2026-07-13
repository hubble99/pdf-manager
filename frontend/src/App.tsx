import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import { Sidebar } from './components/layout/Sidebar';
import { MainContent } from './components/layout/MainContent';
import { MergePage } from './pages/MergePage';
import { ExtractPage } from './pages/ExtractPage';
import { CompressPage } from './pages/CompressPage';
import { PdfToImagePage } from './pages/PdfToImagePage';
import { ImageToPdfPage } from './pages/ImageToPdfPage';
import { QrBarcodePage } from './pages/QrBarcodePage';
import { InsertPage } from './pages/InsertPage';
import { EditPdfPage } from './pages/EditPdfPage';
import { SettingsPage } from './pages/SettingsPage';
import { OrganizePage } from './pages/OrganizePage';
import { MetadataPage } from './pages/MetadataPage';
import { ProtectPage } from './pages/ProtectPage';
import { checkHealth } from './api/client';
import { SplashScreen } from './components/SplashScreen';
import { isTauri } from './utils/tauriDialog';
import { ToastProvider } from './context/ToastContext';
import { FileProvider } from './context/FileContext';
import { ThemeProvider } from './context/ThemeContext';
import { ToastContainer } from './components/ToastContainer';
type AppState = 'splash' | 'ready' | 'error';
type BackendStatus = 'checking' | 'online' | 'offline';

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
        ? 'Connecting to PDF Manager backend...'
        : 'Backend offline — Start the Python server: cd backend && .venv\\Scripts\\uvicorn main:app --reload'}
    </div>
  );
}

export default function App() {
  // In browser/dev mode: skip splash (backend already running via uvicorn)
  // In Tauri production: show splash while sidecar boots up
  const [appState, setAppState] = useState<AppState>(() =>
    isTauri() ? 'splash' : 'ready'
  );
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
          <BrowserRouter>
            <BackendStatusBar status={backendStatus} />
          <div
            className="app-shell"
            style={{ marginTop: topOffset, height: `calc(100vh - ${topOffset}px)` }}
          >
            <Sidebar />
            <MainContent>
              <Routes>
                <Route path="/" element={<Navigate to="/merge" replace />} />
                <Route path="/merge"         element={<MergePage />} />
                <Route path="/extract"       element={<ExtractPage />} />
                <Route path="/compress"      element={<CompressPage />} />
                <Route path="/pdf-to-image"  element={<PdfToImagePage />} />
                <Route path="/image-to-pdf"  element={<ImageToPdfPage />} />
                <Route path="/organize"      element={<OrganizePage />} />
                <Route path="/metadata"      element={<MetadataPage />} />
                <Route path="/protect"       element={<ProtectPage />} />
                <Route path="/qr-barcode"    element={<QrBarcodePage />} />
                <Route path="/insert"        element={<InsertPage />} />
                <Route path="/edit-pdf"      element={<EditPdfPage />} />
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
      </FileProvider>
    </ToastProvider>
    </ThemeProvider>
  );
}
