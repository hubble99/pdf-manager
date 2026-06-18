import { useEffect, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

interface SplashScreenProps {
  onReady: () => void;
  onError: () => void;
}

const MAX_WAIT_MS = 30_000; // 30 seconds timeout
const POLL_INTERVAL_MS = 500; // poll every 500ms

async function pingHealth(): Promise<boolean> {
  try {
    const resp = await fetch('http://127.0.0.1:8000/health', {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export function SplashScreen({ onReady, onError }: SplashScreenProps) {
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('Starting backend engine...');
  const [timedOut, setTimedOut] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let startTime = Date.now();
    let fakeProgress = 0;
    let pollTimer: ReturnType<typeof setTimeout>;

    // Animate progress bar from 0 → 90% over 5 seconds (fake/visual)
    const progressInterval = setInterval(() => {
      if (cancelled) return;
      const elapsed = Date.now() - startTime;
      // Logarithmic fill: fast at start, slows as it approaches 90%
      fakeProgress = Math.min(90, Math.round(90 * (1 - Math.exp(-elapsed / 5000))));
      setProgress(fakeProgress);
    }, 80);

    const poll = async () => {
      if (cancelled) return;

      const elapsed = Date.now() - startTime;
      if (elapsed >= MAX_WAIT_MS) {
        clearInterval(progressInterval);
        setTimedOut(true);
        setStatusText('Backend did not start in time.');
        onError();
        return;
      }

      const attempt = Math.floor(elapsed / POLL_INTERVAL_MS) + 1;
      if (attempt <= 3) setStatusText('Starting backend engine...');
      else if (attempt <= 8) setStatusText('Loading PDF libraries...');
      else setStatusText('Almost ready...');

      const ok = await pingHealth();
      if (ok && !cancelled) {
        clearInterval(progressInterval);
        setProgress(100);
        setStatusText('Ready!');
        setTimeout(onReady, 300); // short pause so user sees 100%
        return;
      }

      if (!cancelled) {
        pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    poll();

    return () => {
      cancelled = true;
      clearInterval(progressInterval);
      clearTimeout(pollTimer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryCount]);

  const handleRetry = () => {
    setTimedOut(false);
    setProgress(0);
    setStatusText('Retrying...');
    setRetryCount((c) => c + 1);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--background)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 99999,
        gap: 0,
      }}
    >
      {/* Logo area */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, marginBottom: 48 }}>
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: 20,
            background: 'linear-gradient(135deg, #4A9EFF 0%, #1a6dd1 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 8px 32px rgba(74, 158, 255, 0.35)',
            animation: 'float 3s ease-in-out infinite',
          }}
        >
          {/* PDF icon */}
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
            <polyline points="10 9 9 9 8 9"/>
          </svg>
        </div>
        <div style={{ textAlign: 'center' }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--on-surface)', letterSpacing: '-0.02em', margin: 0 }}>
            PDF Manager
          </h1>
          <p style={{ fontSize: 13, color: 'var(--on-surface-variant)', marginTop: 4 }}>
            Professional PDF Toolkit
          </p>
        </div>
      </div>

      {/* Status card */}
      <div
        style={{
          width: 340,
          background: 'var(--surface-container-low)',
          border: '1px solid var(--outline-variant)',
          borderRadius: 16,
          padding: '24px 28px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {timedOut ? (
          /* Error state */
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, textAlign: 'center' }}>
            <AlertCircle size={32} color="var(--error)" />
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--on-surface)', marginBottom: 6 }}>
                Backend Failed to Start
              </div>
              <div style={{ fontSize: 13, color: 'var(--on-surface-variant)', lineHeight: 1.5 }}>
                Could not connect to the processing engine. The backend may have crashed or your antivirus may have blocked it.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button
                id="splash-retry-btn"
                className="btn btn-primary btn-sm"
                onClick={handleRetry}
              >
                <RefreshCw size={13} />
                Retry
              </button>
              <button
                id="splash-skip-btn"
                className="btn btn-secondary btn-sm"
                onClick={onReady}
              >
                Continue Anyway
              </button>
            </div>
          </div>
        ) : (
          /* Loading state */
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: progress === 100 ? 'var(--success)' : 'var(--accent)',
                  flexShrink: 0,
                  animation: progress < 100 ? 'pulse-dot 1.2s ease-in-out infinite' : undefined,
                  transition: 'background 0.3s ease',
                }}
              />
              <span style={{ fontSize: 13, color: 'var(--on-surface-variant)', flex: 1 }}>
                {statusText}
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', fontFamily: 'JetBrains Mono, monospace' }}>
                {progress}%
              </span>
            </div>

            {/* Progress bar */}
            <div
              style={{
                height: 6,
                background: 'var(--surface-container-high)',
                borderRadius: 999,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${progress}%`,
                  background: progress === 100
                    ? 'var(--success)'
                    : 'linear-gradient(90deg, #4A9EFF 0%, #6cb2ff 100%)',
                  borderRadius: 999,
                  transition: 'width 0.15s ease, background 0.3s ease',
                  boxShadow: progress < 100 ? '0 0 8px rgba(74,158,255,0.5)' : undefined,
                }}
              />
            </div>

            <p style={{ fontSize: 11, color: 'var(--outline)', textAlign: 'center', margin: 0 }}>
              Initializing PDF processing engine…
            </p>
          </>
        )}
      </div>

      <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-8px); }
        }
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.8); }
        }
      `}</style>
    </div>
  );
}
