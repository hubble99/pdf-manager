import axios from 'axios';
import { useCallback, useEffect, useState } from 'react';
import {
  Barcode,
  Download,
  FolderOpen,
  Info,
  Loader2,
  QrCode,
} from 'lucide-react';
import apiClient from '../api/client';
import { useToast } from '../hooks/useToast';
import { openOutputFolder } from '../utils/tauriDialog';

// ── Types ─────────────────────────────────────────────────────────────────────

type TabType = 'qr' | 'barcode';


// ── Constants ─────────────────────────────────────────────────────────────────

const QR_EC_OPTIONS = [
  { value: 'L', label: 'Low (L)', desc: '7% recovery' },
  { value: 'M', label: 'Medium (M)', desc: '15% recovery' },
  { value: 'Q', label: 'Quartile (Q)', desc: '25% recovery' },
  { value: 'H', label: 'High (H)', desc: '30% recovery' },
];

const BARCODE_TYPES = [
  { value: 'code128', label: 'CODE 128', desc: 'Alphanumeric' },
  { value: 'ean13', label: 'EAN-13', desc: '12-13 digits' },
  { value: 'ean8', label: 'EAN-8', desc: '7-8 digits' },
  { value: 'code39', label: 'CODE 39', desc: 'Uppercase Alphanumeric' },
];

const FORMAT_OPTIONS = [
  { value: 'png', label: 'PNG' },
  { value: 'svg', label: 'SVG' },
];

// ── Helpers ────────────────────────────────────────────────────────────────────


// Custom hook for debouncing value
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function QrBarcodePage() {
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState<TabType>('qr');
  
  // Shared state
  const [format, setFormat] = useState<'png' | 'svg'>('png');
  const [isLoading, setIsLoading] = useState(false);
  const [previewData, setPreviewData] = useState<{ url: string; isSvgText: boolean; svgText?: string; content: string } | null>(null);

  // QR state
  const [qrContent, setQrContent] = useState('');
  const [qrSize, setQrSize] = useState(10);
  const [qrErrorCorrection, setQrErrorCorrection] = useState('M');
  const debouncedQrContent = useDebounce(qrContent, 800);
  
  // Barcode state
  const [barcodeContent, setBarcodeContent] = useState('');
  const [barcodeType, setBarcodeType] = useState('code128');
  const debouncedBarcodeContent = useDebounce(barcodeContent, 800);

  // Output filename
  const [outputFilename, setOutputFilename] = useState('');

  // Cleanup object URLs (all previewData.url are blob URLs now — both PNG and SVG)
  useEffect(() => {
    return () => {
      if (previewData) {
        URL.revokeObjectURL(previewData.url);
      }
    };
  }, [previewData]);


  // ── Generation Logic ────────────────────────────────────────────────────────
  
  const generatePreview = useCallback(async (isUserAction = false, signal?: AbortSignal) => {
    const isQr = activeTab === 'qr';
    const content = isQr ? debouncedQrContent : debouncedBarcodeContent;
    
    if (!content.trim()) {
      setPreviewData(null);
      return;
    }
    
    // Validation for Barcode
    if (!isQr) {
      if (barcodeType === 'ean13') {
        if (!/^\d{12,13}$/.test(content)) {
          if (isUserAction) showToast({ type: 'error', title: 'Invalid Content', message: 'EAN-13 requires 12-13 digits.' });
          setPreviewData(null);
          return;
        }
      } else if (barcodeType === 'ean8') {
        if (!/^\d{7,8}$/.test(content)) {
          if (isUserAction) showToast({ type: 'error', title: 'Invalid Content', message: 'EAN-8 requires 7-8 digits.' });
          setPreviewData(null);
          return;
        }
      }
    }

    setIsLoading(true);
    
    try {
      let endpoint = '';
      let payload = {};

      if (isQr) {
        endpoint = '/api/v1/qr-barcode/qr';
        payload = {
          content,
          size: qrSize,
          error_correction: qrErrorCorrection,
          format: format,
          border: 4,
        };
      } else {
        endpoint = '/api/v1/qr-barcode/barcode';
        payload = {
          content,
          barcode_type: barcodeType,
          format: format,
        };
      }

      const response = await apiClient.post(endpoint, payload, {
        responseType: format === 'svg' ? 'text' : 'blob',
        signal,
      });

      if (previewData && !previewData.isSvgText) {
        URL.revokeObjectURL(previewData.url);
      }

      if (format === 'svg') {
        // Convert SVG bytes/text to a Blob URL for reliable <img> rendering
        // Handles qrcode library's SVG namespace (svg:rect xmlns:svg=...) which breaks dangerouslySetInnerHTML
        const svgText = response.data as string;
        const blob = new Blob([svgText], { type: 'image/svg+xml' });
        const blobUrl = URL.createObjectURL(blob);
        setPreviewData({ url: blobUrl, isSvgText: true, svgText, content });
      } else {
        const blob = new Blob([response.data], { type: 'image/png' });
        setPreviewData({ url: URL.createObjectURL(blob), isSvgText: false, content });
      }

      if (isUserAction) {
        showToast({ type: 'success', title: 'Generated successfully', message: `${isQr ? 'QR Code' : 'Barcode'} is ready to download.` });
      }

    } catch (err: unknown) {
      if (axios.isCancel(err) || (err instanceof Error && err.name === 'AbortError')) {
        return;
      }
      if (isUserAction) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        showToast({ type: 'error', title: 'Generation failed', message: msg });
      }
      setPreviewData(null);
    } finally {
      setIsLoading(false);
    }
  }, [
    activeTab, 
    debouncedQrContent, 
    debouncedBarcodeContent, 
    qrSize, 
    qrErrorCorrection, 
    barcodeType, 
    format, 
    previewData
  ]);

  // Trigger preview generation when debounced inputs or settings change
  useEffect(() => {
    const controller = new AbortController();
    generatePreview(false, controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    debouncedQrContent,
    debouncedBarcodeContent,
    qrSize,
    qrErrorCorrection,
    barcodeType,
    format,
    activeTab
  ]);

  // ── Download ────────────────────────────────────────────────────────────────
  const handleDownload = () => {
    if (!previewData) return;

    const isQr = activeTab === 'qr';
    const defaultName = isQr ? 'qrcode' : 'barcode';
    const userStem = outputFilename.trim().replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_') || defaultName;
    const filename = `${userStem}.${format}`;

    const a = document.createElement('a');
    a.download = filename;

    if (previewData.isSvgText && previewData.svgText) {
      // For SVG download: create a fresh blob from the raw SVG text
      const blob = new Blob([previewData.svgText], { type: 'image/svg+xml' });
      a.href = URL.createObjectURL(blob);
    } else {
      a.href = previewData.url;
    }

    a.click();
    showToast({ type: 'success', title: 'Download started', message: `Saving ${filename}` });

    if (previewData.isSvgText && previewData.svgText) {
      URL.revokeObjectURL(a.href);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: 36, height: 36, borderRadius: 'var(--radius-md)',
            background: 'var(--accent-dim)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', color: 'var(--accent)',
          }}>
            <QrCode size={20} strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="page-title">QR & Barcode</h1>
            <p className="page-subtitle">Generate custom QR codes and barcodes</p>
          </div>
        </div>
      </div>

      {/* ── Tabs ────────────────────────────────────────────────────────────── */}
      <div style={{ borderBottom: '1px solid var(--outline-variant)', padding: '0 24px' }}>
        <div style={{ display: 'flex', gap: 24, maxWidth: 840, margin: '0 auto' }}>
          <button
            className={`tab-btn ${activeTab === 'qr' ? 'active' : ''}`}
            onClick={() => setActiveTab('qr')}
            style={{
              background: 'none',
              border: 'none',
              padding: '12px 4px',
              fontSize: 14,
              fontWeight: activeTab === 'qr' ? 600 : 500,
              color: activeTab === 'qr' ? 'var(--accent)' : 'var(--on-surface-variant)',
              borderBottom: `2px solid ${activeTab === 'qr' ? 'var(--accent)' : 'transparent'}`,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              transition: 'all var(--transition-fast)',
            }}
          >
            <QrCode size={16} /> QR Code
          </button>
          <button
            className={`tab-btn ${activeTab === 'barcode' ? 'active' : ''}`}
            onClick={() => setActiveTab('barcode')}
            style={{
              background: 'none',
              border: 'none',
              padding: '12px 4px',
              fontSize: 14,
              fontWeight: activeTab === 'barcode' ? 600 : 500,
              color: activeTab === 'barcode' ? 'var(--accent)' : 'var(--on-surface-variant)',
              borderBottom: `2px solid ${activeTab === 'barcode' ? 'var(--accent)' : 'transparent'}`,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              transition: 'all var(--transition-fast)',
            }}
          >
            <Barcode size={16} /> Barcode
          </button>
        </div>
      </div>

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div className="page-body">
        <div style={{ maxWidth: 840, margin: '0 auto', display: 'grid', gridTemplateColumns: '1fr 340px', gap: 24 }}>
          
          {/* Left Column: Form */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {activeTab === 'qr' ? (
              <>
                <div className="card">
                  <label className="input-label" htmlFor="qr-content">Content</label>
                  <textarea
                    id="qr-content"
                    className="input"
                    value={qrContent}
                    onChange={(e) => setQrContent(e.target.value)}
                    placeholder="Enter URL, text, or data..."
                    rows={4}
                    style={{ resize: 'vertical' }}
                  />
                </div>

                <div className="card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <label className="input-label" style={{ margin: 0 }}>Size</label>
                    <span className="badge badge-neutral">{qrSize}</span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="20"
                    value={qrSize}
                    onChange={(e) => setQrSize(parseInt(e.target.value, 10))}
                    style={{
                      width: '100%',
                      accentColor: 'var(--accent)',
                      height: 4,
                    }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11, color: 'var(--on-surface-variant)' }}>
                    <span>Small (1)</span>
                    <span>Large (20)</span>
                  </div>
                </div>

                <div className="card">
                  <label className="input-label">Error Correction</label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 4 }}>
                    {QR_EC_OPTIONS.map((opt) => (
                      <label
                        key={opt.value}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '10px 14px',
                          borderRadius: 'var(--radius-md)',
                          border: `1px solid ${qrErrorCorrection === opt.value ? 'var(--accent)' : 'var(--outline-variant)'}`,
                          background: qrErrorCorrection === opt.value ? 'var(--accent-dim)' : 'var(--surface-container)',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="radio"
                          name="errorCorrection"
                          value={opt.value}
                          checked={qrErrorCorrection === opt.value}
                          onChange={() => setQrErrorCorrection(opt.value)}
                          style={{ accentColor: 'var(--accent)' }}
                        />
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{opt.label}</div>
                          <div style={{ fontSize: 11, color: 'var(--on-surface-variant)' }}>{opt.desc}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="card">
                  <label className="input-label" htmlFor="barcode-content">Content</label>
                  <input
                    id="barcode-content"
                    className="input"
                    type="text"
                    value={barcodeContent}
                    onChange={(e) => setBarcodeContent(e.target.value)}
                    placeholder="Enter barcode data..."
                  />
                  {barcodeType.startsWith('ean') && (
                    <p className="text-muted text-body-sm" style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                      <Info size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                      <span>
                        {barcodeType === 'ean13' 
                          ? 'EAN-13 requires 12 or 13 numeric digits. The 13th digit is automatically generated as a checksum.' 
                          : 'EAN-8 requires 7 or 8 numeric digits. The 8th digit is automatically generated as a checksum.'}
                      </span>
                    </p>
                  )}
                </div>

                <div className="card">
                  <label className="input-label">Barcode Type</label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 4 }}>
                    {BARCODE_TYPES.map((opt) => (
                      <label
                        key={opt.value}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '10px 14px',
                          borderRadius: 'var(--radius-md)',
                          border: `1px solid ${barcodeType === opt.value ? 'var(--accent)' : 'var(--outline-variant)'}`,
                          background: barcodeType === opt.value ? 'var(--accent-dim)' : 'var(--surface-container)',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="radio"
                          name="barcodeType"
                          value={opt.value}
                          checked={barcodeType === opt.value}
                          onChange={() => setBarcodeType(opt.value)}
                          style={{ accentColor: 'var(--accent)' }}
                        />
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{opt.label}</div>
                          <div style={{ fontSize: 11, color: 'var(--on-surface-variant)' }}>{opt.desc}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              </>
            )}

            <div className="card">
              <label className="input-label">Export Format</label>
              <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                {FORMAT_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    style={{
                      flex: 1,
                      display: 'flex',
                      justifyContent: 'center',
                      alignItems: 'center',
                      gap: 8,
                      padding: '10px 14px',
                      borderRadius: 'var(--radius-md)',
                      border: `1px solid ${format === opt.value ? 'var(--accent)' : 'var(--outline-variant)'}`,
                      background: format === opt.value ? 'var(--accent-dim)' : 'var(--surface-container)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="radio"
                      name="format"
                      value={opt.value}
                      checked={format === opt.value}
                      onChange={() => setFormat(opt.value as 'png' | 'svg')}
                      style={{ margin: 0, accentColor: 'var(--accent)' }}
                    />
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{opt.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* Right Column: Preview & Download */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 340 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>Preview</h3>
              
              <div style={{
                flex: 1,
                background: previewData ? '#ffffff' : 'var(--surface)',
                borderRadius: 'var(--radius-md)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid var(--outline-variant)',
                padding: 24,
                position: 'relative',
                overflow: 'hidden'
              }}>
                {isLoading ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, color: 'var(--on-surface-variant)' }}>
                    <Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} />
                    <span style={{ fontSize: 13 }}>Generating...</span>
                  </div>
                ) : previewData ? (
                  <div style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
                    {/* All formats (PNG, SVG) rendered via <img> with Blob URL */}
                    <img 
                      src={previewData.url} 
                      alt="Preview" 
                      style={{ maxWidth: '100%', maxHeight: 250, objectFit: 'contain' }} 
                    />
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', color: 'var(--on-surface-variant)' }}>
                    {activeTab === 'qr' ? <QrCode size={32} style={{ margin: '0 auto 12px', opacity: 0.5 }} /> : <Barcode size={32} style={{ margin: '0 auto 12px', opacity: 0.5 }} />}
                    <p style={{ fontSize: 13 }}>Enter content to see preview</p>
                  </div>
                )}
              </div>

              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* Output filename input */}
                <div>
                  <label className="input-label" htmlFor="qr-output-name"
                    style={{ fontSize: 12, marginBottom: 4 }}>Output filename</label>
                  <input
                    id="qr-output-name"
                    className="input"
                    type="text"
                    value={outputFilename}
                    onChange={(e) => setOutputFilename(e.target.value)}
                    placeholder={`${activeTab === 'qr' ? 'qrcode' : 'barcode'}.${format}`}
                    style={{ fontSize: 13, padding: '7px 10px' }}
                  />
                </div>

                {/* Download + Open Folder — stacked full-width for even symmetry */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button
                    className="btn btn-primary"
                    style={{ width: '100%' }}
                    onClick={handleDownload}
                    disabled={!previewData || isLoading}
                  >
                    <Download size={15} />
                    Download {format.toUpperCase()}
                  </button>
                  <button
                    className="btn btn-secondary"
                    style={{ width: '100%' }}
                    onClick={() => openOutputFolder()}
                    disabled={!previewData || isLoading}
                  >
                    <FolderOpen size={15} />
                    Open Folder
                  </button>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>

      

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
