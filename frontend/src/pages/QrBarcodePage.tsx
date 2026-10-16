import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { PageHeader } from '../components/ui';
import { buildOutputFilename } from '../utils/filenamePolicy';
import { normalizeQrContent } from '../utils/qrContent';
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
  { value: 'png', label: 'PNG', desc: 'Fixed size, easy to share' },
  { value: 'svg', label: 'SVG', desc: 'Scales without blur, best for print' },
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

  // Sequence of the newest generation request. Only that request may commit
  // preview/loading state; superseded or aborted requests are ignored.
  const requestIdRef = useRef(0);

  // Sole owner of preview object URLs: revokes the previous URL when
  // previewData changes and on unmount (PNG and SVG are both blob URLs).
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
    const content = isQr ? normalizeQrContent(debouncedQrContent) : debouncedBarcodeContent;

    const requestId = ++requestIdRef.current;

    if (!content.trim()) {
      setIsLoading(false);
      setPreviewData(null);
      return;
    }

    // Validation for Barcode
    if (!isQr) {
      if (barcodeType === 'ean13') {
        if (!/^\d{12,13}$/.test(content)) {
          if (isUserAction) showToast({ type: 'error', title: 'Invalid Content', message: 'EAN-13 requires 12-13 digits.' });
          setIsLoading(false);
          setPreviewData(null);
          return;
        }
      } else if (barcodeType === 'ean8') {
        if (!/^\d{7,8}$/.test(content)) {
          if (isUserAction) showToast({ type: 'error', title: 'Invalid Content', message: 'EAN-8 requires 7-8 digits.' });
          setIsLoading(false);
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

      if (requestId !== requestIdRef.current) {
        return;
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
      if (requestId !== requestIdRef.current) {
        return;
      }
      if (isUserAction) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        showToast({ type: 'error', title: 'Generation failed', message: msg });
      }
      setPreviewData(null);
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [
    activeTab, 
    debouncedQrContent, 
    debouncedBarcodeContent, 
    qrSize, 
    qrErrorCorrection, 
    barcodeType, 
    format, 
    showToast
  ]);

  // Trigger preview generation when debounced inputs or settings change
  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    generatePreview(false, controller.signal);
    return () => controller.abort();
  }, [generatePreview]);

  // ── Download ────────────────────────────────────────────────────────────────
  const handleDownload = () => {
    if (!previewData) return;

    const isQr = activeTab === 'qr';
    const defaultName = isQr ? 'qrcode' : 'barcode';
    const filename = buildOutputFilename(outputFilename, format, defaultName);

    const a = document.createElement('a');
    a.download = filename;
    a.href = previewData.url;

    // The preview URL stays owned by previewData. SVG keeps its raw text, so
    // download a throwaway blob URL and revoke it after the browser started
    // the download (revoking synchronously can cancel it).
    let tempUrl: string | null = null;
    if (previewData.isSvgText && previewData.svgText) {
      const blob = new Blob([previewData.svgText], { type: 'image/svg+xml' });
      tempUrl = URL.createObjectURL(blob);
      a.href = tempUrl;
    }

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    if (tempUrl) {
      window.setTimeout(() => URL.revokeObjectURL(tempUrl as string), 5000);
    }

    showToast({ type: 'success', title: 'Download started', message: `Saving ${filename}` });
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  const optionCard = (
    group: string,
    opt: { value: string; label: string; desc: string },
    selected: boolean,
    onSelect: () => void,
  ) => (
    <label key={opt.value} className={`radio-card${selected ? ' active' : ''}`}>
      <input type="radio" name={group} value={opt.value} checked={selected} onChange={onSelect} />
      <span className="radio-copy">
        <span className="radio-title">{opt.label}</span>
        <span className="radio-desc">{opt.desc}</span>
      </span>
    </label>
  );

  return (
    <div className="feature-page">
      <PageHeader
        icon={QrCode}
        title="QR & Barcode"
        description="Generate custom QR codes and barcodes"
      />

      <div className="tabs" role="tablist" aria-label="QR and barcode modes">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'qr'}
          className={`tab${activeTab === 'qr' ? ' active' : ''}`}
          onClick={() => setActiveTab('qr')}
          id="qr-tab-qr"
        >
          <QrCode size={15} aria-hidden="true" /> QR Code
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'barcode'}
          className={`tab${activeTab === 'barcode' ? ' active' : ''}`}
          onClick={() => setActiveTab('barcode')}
          id="qr-tab-barcode"
        >
          <Barcode size={15} aria-hidden="true" /> Barcode
        </button>
      </div>

      <div className="page-body">
        <div className="form-col form-col--wide form-col--two">

          {/* Left column: what to encode and how */}
          <div className="col-stack">
            {activeTab === 'qr' ? (
              <>
                <div className="card card--flush">
                  <div className="card-head">
                    <span className="card-head-title">
                      <label htmlFor="qr-content">Content</label>
                    </span>
                  </div>
                  <div className="card-body">
                    <textarea
                      id="qr-content"
                      className="input"
                      value={qrContent}
                      onChange={(e) => setQrContent(e.target.value)}
                      placeholder="Enter URL, text, or data..."
                      rows={5}
                    />
                    {normalizeQrContent(qrContent) !== qrContent && (
                      <p className="text-muted text-body-sm" style={{ marginTop: 6 }} id="qr-link-note">
                        Saved as <strong>{normalizeQrContent(qrContent).trim()}</strong> so phones open it as a link.
                      </p>
                    )}
                  </div>
                </div>

                <div className="card card--flush">
                  <div className="card-head">
                    <span className="card-head-title">Error correction</span>
                  </div>
                  <div className="card-body">
                    <div className="opt-grid" role="radiogroup" aria-label="Error correction">
                      {QR_EC_OPTIONS.map((opt) => optionCard(
                        'errorCorrection', opt, qrErrorCorrection === opt.value,
                        () => setQrErrorCorrection(opt.value),
                      ))}
                    </div>
                    <small className="hint">Higher levels survive more damage but hold less content.</small>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="card card--flush">
                  <div className="card-head">
                    <span className="card-head-title">
                      <label htmlFor="barcode-content">Content</label>
                    </span>
                  </div>
                  <div className="card-body">
                    <input
                      id="barcode-content"
                      className="input"
                      type="text"
                      value={barcodeContent}
                      onChange={(e) => setBarcodeContent(e.target.value)}
                      placeholder="Enter barcode data..."
                    />
                    {barcodeType.startsWith('ean') && (
                      <small className="hint hint--icon">
                        <Info size={13} aria-hidden="true" />
                        <span>
                          {barcodeType === 'ean13'
                            ? 'EAN-13 requires 12 or 13 numeric digits. The 13th digit is automatically generated as a checksum.'
                            : 'EAN-8 requires 7 or 8 numeric digits. The 8th digit is automatically generated as a checksum.'}
                        </span>
                      </small>
                    )}
                  </div>
                </div>

                <div className="card card--flush">
                  <div className="card-head">
                    <span className="card-head-title">Barcode type</span>
                  </div>
                  <div className="card-body">
                    <div className="opt-grid" role="radiogroup" aria-label="Barcode type">
                      {BARCODE_TYPES.map((opt) => optionCard(
                        'barcodeType', opt, barcodeType === opt.value,
                        () => setBarcodeType(opt.value),
                      ))}
                    </div>
                  </div>
                </div>
              </>
            )}

            <div className="card card--flush">
              <div className="card-head">
                <span className="card-head-title">Export format</span>
              </div>
              <div className="card-body">
                <div className="opt-grid" role="radiogroup" aria-label="Export format">
                  {FORMAT_OPTIONS.map((opt) => optionCard(
                    'format', opt, format === opt.value,
                    () => setFormat(opt.value as 'png' | 'svg'),
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Right column: preview and download */}
          <div className="col-stack">
            <div className="card card--flush">
              <div className="card-head">
                <span className="card-head-title">Preview</span>
              </div>
              <div className="card-body">
                <div className="preview-box">
                  {isLoading ? (
                    <div className="preview-empty">
                      <Loader2 size={24} className="spin" />
                      <span>Generating...</span>
                    </div>
                  ) : previewData ? (
                    <img src={previewData.url} alt="Preview" />
                  ) : (
                    <div className="preview-empty">
                      {activeTab === 'qr' ? <QrCode size={32} aria-hidden="true" /> : <Barcode size={32} aria-hidden="true" />}
                      <span>Enter content to see preview</span>
                    </div>
                  )}
                </div>

                {activeTab === 'qr' && (
                  <div className="field">
                    <label htmlFor="qr-size-slider">
                      Size <span className="chip">{qrSize}</span>
                    </label>
                    <input
                      id="qr-size-slider"
                      className="range"
                      type="range"
                      min="1"
                      max="20"
                      value={qrSize}
                      onChange={(e) => setQrSize(parseInt(e.target.value, 10))}
                    />
                    <div className="range-scale">
                      <span>Small (1)</span>
                      <span>Large (20)</span>
                    </div>
                  </div>
                )}

                <div className="field">
                  <label htmlFor="qr-output-name">Output filename</label>
                  <input
                    id="qr-output-name"
                    className="input"
                    type="text"
                    value={outputFilename}
                    onChange={(e) => setOutputFilename(e.target.value)}
                    placeholder={`${activeTab === 'qr' ? 'qrcode' : 'barcode'}.${format}`}
                  />
                </div>

                <div className="stack-actions">
                  <button
                    className="btn btn-primary"
                    onClick={handleDownload}
                    disabled={!previewData || isLoading}
                  >
                    <Download size={15} />
                    Download {format.toUpperCase()}
                  </button>
                  <button
                    className="btn btn-secondary"
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
    </div>
  );
}
