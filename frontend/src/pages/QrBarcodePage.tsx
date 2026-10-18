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
import { PageHeader, RadioCardGroup, RangeField, Tabs } from '../components/ui';
import { buildOutputFilename } from '../utils/filenamePolicy';
import { normalizeQrContent } from '../utils/qrContent';
import { openOutputFolder } from '../utils/tauriDialog';
import { t } from '../i18n';

// ── Types ─────────────────────────────────────────────────────────────────────

type TabType = 'qr' | 'barcode';


// ── Constants ─────────────────────────────────────────────────────────────────

const QR_EC_OPTIONS = [
  { value: 'L', label: t('Low (L)'), desc: t('7% recovery') },
  { value: 'M', label: t('Medium (M)'), desc: t('15% recovery') },
  { value: 'Q', label: t('Quartile (Q)'), desc: t('25% recovery') },
  { value: 'H', label: t('High (H)'), desc: t('30% recovery') },
];

const BARCODE_TYPES = [
  { value: 'code128', label: 'CODE 128', desc: t('Alphanumeric') },
  { value: 'ean13', label: 'EAN-13', desc: t('12-13 digits') },
  { value: 'ean8', label: 'EAN-8', desc: t('7-8 digits') },
  { value: 'code39', label: 'CODE 39', desc: t('Uppercase Alphanumeric') },
];

const FORMAT_OPTIONS = [
  { value: 'png', label: 'PNG', desc: t('Fixed size, easy to share') },
  { value: 'svg', label: 'SVG', desc: t('Scales without blur, best for print') },
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
          if (isUserAction) showToast({ type: 'error', title: t('Invalid Content'), message: t('EAN-13 requires 12-13 digits.') });
          setIsLoading(false);
          setPreviewData(null);
          return;
        }
      } else if (barcodeType === 'ean8') {
        if (!/^\d{7,8}$/.test(content)) {
          if (isUserAction) showToast({ type: 'error', title: t('Invalid Content'), message: t('EAN-8 requires 7-8 digits.') });
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
        showToast({ type: 'success', title: t('Generated successfully'), message: t('{kind} is ready.', { kind: isQr ? t('QR Code') : t('Barcode') }) });
      }

    } catch (err: unknown) {
      if (axios.isCancel(err) || (err instanceof Error && err.name === 'AbortError')) {
        return;
      }
      if (requestId !== requestIdRef.current) {
        return;
      }
      if (isUserAction) {
        const msg = err instanceof Error ? err.message : t('Unknown error');
        showToast({ type: 'error', title: t('Generation failed'), message: msg });
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

    showToast({ type: 'success', title: t('File saved'), message: t('Saved {name} to your Downloads folder', { name: filename }) });
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="feature-page">
      <PageHeader
        icon={QrCode}
        title={t('QR & Barcode')}
        description={t('Generate custom QR codes and barcodes')}
      />

      <Tabs
        ariaLabel={t('QR and barcode modes')}
        value={activeTab}
        onChange={setActiveTab}
        items={[
          { value: 'qr', id: 'qr-tab-qr', label: t('QR Code'), icon: <QrCode size={15} aria-hidden="true" /> },
          { value: 'barcode', id: 'qr-tab-barcode', label: t('Barcode'), icon: <Barcode size={15} aria-hidden="true" /> },
        ]}
      />

      <div className="page-body">
        <div className="form-col form-col--wide form-col--two">

          {/* Left column: what to encode and how */}
          <div className="col-stack">
            {activeTab === 'qr' ? (
              <>
                <div className="card card--flush">
                  <div className="card-head">
                    <span className="card-head-title">
                      <label htmlFor="qr-content">{t('Content')}</label>
                    </span>
                  </div>
                  <div className="card-body">
                    <textarea
                      id="qr-content"
                      className="input"
                      value={qrContent}
                      onChange={(e) => setQrContent(e.target.value)}
                      placeholder={t('Enter URL, text, or data...')}
                      rows={5}
                    />
                    {normalizeQrContent(qrContent) !== qrContent && (
                      <p className="text-muted text-body-sm hint-gap-sm" id="qr-link-note">
                        {t('Saved as')} <strong>{normalizeQrContent(qrContent).trim()}</strong> {t('so phones open it as a link.')}
                      </p>
                    )}
                  </div>
                </div>

                <div className="card card--flush">
                  <div className="card-head">
                    <span className="card-head-title">{t('Error correction')}</span>
                  </div>
                  <div className="card-body">
                    <RadioCardGroup
                      ariaLabel={t('Error correction')}
                      name="errorCorrection"
                      options={QR_EC_OPTIONS}
                      value={qrErrorCorrection}
                      onChange={setQrErrorCorrection}
                    />
                    <small className="hint">{t('Higher levels survive more damage but hold less content.')}</small>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="card card--flush">
                  <div className="card-head">
                    <span className="card-head-title">
                      <label htmlFor="barcode-content">{t('Content')}</label>
                    </span>
                  </div>
                  <div className="card-body">
                    <input
                      id="barcode-content"
                      className="input"
                      type="text"
                      value={barcodeContent}
                      onChange={(e) => setBarcodeContent(e.target.value)}
                      placeholder={t('Enter barcode data...')}
                    />
                    {barcodeType.startsWith('ean') && (
                      <small className="hint hint--icon">
                        <Info size={13} aria-hidden="true" />
                        <span>
                          {barcodeType === 'ean13'
                            ? t('EAN-13 requires 12 or 13 numeric digits. The 13th digit is automatically generated as a checksum.')
                            : t('EAN-8 requires 7 or 8 numeric digits. The 8th digit is automatically generated as a checksum.')}
                        </span>
                      </small>
                    )}
                  </div>
                </div>

                <div className="card card--flush">
                  <div className="card-head">
                    <span className="card-head-title">{t('Barcode type')}</span>
                  </div>
                  <div className="card-body">
                    <RadioCardGroup
                      ariaLabel={t('Barcode type')}
                      name="barcodeType"
                      options={BARCODE_TYPES}
                      value={barcodeType}
                      onChange={setBarcodeType}
                    />
                  </div>
                </div>
              </>
            )}

            <div className="card card--flush">
              <div className="card-head">
                <span className="card-head-title">{t('Export format')}</span>
              </div>
              <div className="card-body">
                <RadioCardGroup
                  ariaLabel={t('Export format')}
                  name="format"
                  options={FORMAT_OPTIONS as readonly { value: 'png' | 'svg'; label: string; desc: string }[]}
                  value={format}
                  onChange={setFormat}
                />
              </div>
            </div>
          </div>

          {/* Right column: preview and download */}
          <div className="col-stack">
            <div className="card card--flush">
              <div className="card-head">
                <span className="card-head-title">{t('Preview')}</span>
              </div>
              <div className="card-body">
                <div className={`preview-box${activeTab === 'qr' ? ' preview-box--qr' : ''}`}>
                  {isLoading ? (
                    <div className="preview-empty">
                      <Loader2 size={24} className="spin" />
                      <span>{t('Generating...')}</span>
                    </div>
                  ) : previewData ? (
                    <img src={previewData.url} alt={t('Preview')} />
                  ) : (
                    <div className="preview-empty">
                      {activeTab === 'qr' ? <QrCode size={32} aria-hidden="true" /> : <Barcode size={32} aria-hidden="true" />}
                      <span>{t('Enter content to see preview')}</span>
                    </div>
                  )}
                </div>

                {activeTab === 'qr' && (
                  <div className="field">
                    <label htmlFor="qr-size-slider">
                      {t('Size')} <span className="chip">{qrSize}</span>
                    </label>
                    <RangeField
                      id="qr-size-slider"
                      min={1}
                      max={20}
                      value={qrSize}
                      onChange={setQrSize}
                      scale={(
                        <>
                          <span>{t('Small (1)')}</span>
                          <span>{t('Large (20)')}</span>
                        </>
                      )}
                    />
                  </div>
                )}

                <div className="field">
                  <label htmlFor="qr-output-name">{t('Output filename')}</label>
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
                    {t('Save {format}', { format: format.toUpperCase() })}
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => openOutputFolder()}
                    disabled={!previewData || isLoading}
                  >
                    <FolderOpen size={15} />
                    {t('Open Folder')}
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
