import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  FileText,
  FileType2,
  FolderOpen,
  Info,
  Loader2,
  Upload,
  X,
} from 'lucide-react';
import { Filename } from '../components/Filename';
import { PageHeader } from '../components/ui';
import { PDF_TO_WORD_BETA_NOTE } from '../config/features';
import { useToast } from '../hooks/useToast';
import { addHistoryEntry } from '../utils/historyStore';
import { openOutputFolder } from '../utils/tauriDialog';
import { useNativePaths } from '../hooks/useNativePaths';
import {
  convertPdfToWord,
  isCoreCancelled,
  type CoreProgress,
  type PdfToWordReport,
} from '../api/nativeCore';
import { t, tn } from '../i18n';
import { baseName, errorMessage, formatBytes, pageList, stemOf } from '../utils/pdfToWord';

const PDF_FILTER = { name: 'PDF', extensions: ['pdf'] };

export function PdfToWordPage() {
  const { showToast } = useToast();
  const [inputPath, setInputPath] = useState<string | null>(null);
  const [outputName, setOutputName] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<CoreProgress | null>(null);
  const [result, setResult] = useState<PdfToWordReport | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadPath = useCallback((path: string) => {
    setInputPath(path);
    setOutputName(stemOf(path));
    setResult(null);
  }, []);

  const { desktop, isDragOver, pick: pickFile } = useNativePaths({
    filter: PDF_FILTER,
    pickerTitle: t('Choose a PDF to convert'),
    disabled: running,
    onPaths: (accepted, rejected) => {
      if (accepted[0]) loadPath(accepted[0]);
      else if (rejected > 0) showToast({ type: 'error', title: t('Invalid file'), message: t('Only PDF files are accepted.') });
    },
  });

  useEffect(() => () => abortRef.current?.abort(), []);

  const convert = async () => {
    if (!inputPath) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setResult(null);
    setProgress(null);
    try {
      const report = await convertPdfToWord(inputPath, outputName, {
        signal: controller.signal,
        onProgress: setProgress,
      });
      setResult(report);
      addHistoryEntry({ filename: baseName(report.outputPath), action: 'PDF to Word', size: report.outputSizeBytes });
      showToast({
        type: 'success',
        title: t('Word document ready'),
        message: baseName(report.outputPath),
        action: { label: t('Open Folder'), onClick: () => openOutputFolder() },
        duration: 8000,
      });
    } catch (err) {
      if (isCoreCancelled(err)) {
        showToast({ type: 'info', title: t('Conversion cancelled'), message: t('No file was saved.') });
      } else {
        showToast({ type: 'error', title: t('Conversion failed'), message: errorMessage(err) });
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
      setProgress(null);
    }
  };

  const clear = () => {
    setInputPath(null);
    setOutputName('');
    setResult(null);
  };

  const percent = progress?.total ? Math.round((progress.done / progress.total) * 100) : null;

  return (
    <div className="feature-page">
      <PageHeader
        icon={FileType2}
        title={t('PDF to Word')}
        description={t('Turn a PDF into an editable Word document (.docx)')}
        badge={{ label: 'BETA', title: PDF_TO_WORD_BETA_NOTE }}
      />

      <div className="page-body">
        <div className={`form-col${inputPath ? '' : ' form-col--center'}`}>
          <div className="card status-card" role="note" id="pdf-to-word-beta-note">
            <Info size={20} aria-hidden="true" />
            <div className="status-card-copy">
              <b>{t('Beta')}</b>
              <small>{PDF_TO_WORD_BETA_NOTE}</small>
            </div>
          </div>
          {!desktop ? (
            <div className="card status-card" role="note">
              <Info size={20} aria-hidden="true" />
              <div className="status-card-copy">
                <b>{t('PDF to Word runs in the Dokuwu desktop app')}</b>
                <small>{t('It reads the file directly from your computer, which the browser preview cannot do.')}</small>
              </div>
            </div>
          ) : !inputPath ? (
            <>
              <div
                id="pdf-to-word-drop-zone"
                className={`drop-zone${isDragOver ? ' drag-over' : ''}`}
                onClick={() => void pickFile()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && void pickFile()}
                aria-label={t('Drop a PDF file here or click to browse')}
              >
                <Upload className="drop-zone-icon" />
                <p className="drop-zone-title">{t('Drop a PDF here')}</p>
                <p className="drop-zone-sub">{t('or click to browse · One file at a time')}</p>
                <span className="badge badge-neutral">PDF</span>
              </div>
              <p className="empty-hint">{t('Text, headings, lists, tables and images are rebuilt as editable Word content.')}</p>
            </>
          ) : (
            <>
              <div className="card card--flush">
                <div className="card-head">
                  <span className="card-head-title">
                    <FileText size={16} className="card-head-icon" aria-hidden="true" />
                    <Filename name={baseName(inputPath)} className="file-item-name" />
                  </span>
                  <span className="card-head-actions">
                    <button type="button" className="link-btn" id="pdf-to-word-change-file" onClick={() => void pickFile()} disabled={running}>
                      {t('Change file')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm converter-danger"
                      id="pdf-to-word-remove-file"
                      onClick={clear}
                      disabled={running}
                      aria-label={t('Remove file')}
                      title={t('Remove file')}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </span>
                </div>
              </div>

              <div className="card card--flush">
                <div className="card-body">
                  <div className="field">
                    <label htmlFor="pdf-to-word-output-name">{t('Output Filename')}</label>
                    <div className="input-suffix-wrap">
                      <input
                        id="pdf-to-word-output-name"
                        className="input"
                        type="text"
                        value={outputName}
                        disabled={running}
                        onChange={(e) => setOutputName(e.target.value)}
                        placeholder={stemOf(inputPath)}
                      />
                      <span className="input-suffix">.docx</span>
                    </div>
                  </div>
                  <small className="hint">
                    {t('The layout is rebuilt from the PDF, so check complex pages in Word. Scanned pages stay pictures: Dokuwu does not read text from images.')}
                  </small>
                </div>
              </div>

              {running && (
                <div className="card status-card" role="status" aria-live="polite">
                  <Loader2 size={20} className="spin" aria-hidden="true" />
                  <div className="status-card-copy">
                    <b>
                      {progress?.stage === 'saving'
                        ? t('Saving the Word document…')
                        : progress?.stage === 'page' && progress.total
                          ? t('Converting page {done} of {total}…', { done: Math.min(progress.done + 1, progress.total), total: progress.total })
                          : t('Opening the PDF…')}
                    </b>
                    {percent !== null && (
                      <div className="size-bar size-bar--spaced">
                        <i style={{ width: `${percent}%` }} />
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    id="pdf-to-word-cancel-btn"
                    onClick={() => abortRef.current?.abort()}
                  >
                    {t('Cancel')}
                  </button>
                </div>
              )}

              {result && (
                <div className="card status-card status-card--ok">
                  <CheckCircle size={22} aria-hidden="true" />
                  <div className="status-card-copy">
                    <b>{t('Saved to your Downloads folder')}</b>
                    <small>
                      <Filename name={baseName(result.outputPath)} /> · {formatBytes(result.outputSizeBytes)} · {tn(result.pages, '{n} page', '{n} pages')}
                      {result.tables > 0 && <> · {tn(result.tables, '{n} table', '{n} tables')}</>}
                      {result.images > 0 && <> · {tn(result.images, '{n} image', '{n} images')}</>}
                    </small>
                  </div>
                  <button
                    className="btn btn-ghost btn-sm"
                    id="pdf-to-word-open-folder-btn"
                    onClick={() => openOutputFolder()}
                    title={t('Open folder')}
                  >
                    <FolderOpen size={14} />
                    {t('Open Folder')}
                  </button>
                </div>
              )}

              {result && result.pagesWithoutText.length > 0 && (
                <div className="card status-card status-card--warn" role="note">
                  <AlertTriangle size={20} aria-hidden="true" />
                  <div className="status-card-copy">
                    <b>{tn(result.pagesWithoutText.length, '{n} page has no text to edit', '{n} pages have no text to edit')}</b>
                    <small>
                      {tn(
                        result.pagesWithoutText.length,
                        'Page {pages} looks scanned, so it was kept as a picture.',
                        'Pages {pages} look scanned, so they were kept as pictures.',
                        { pages: pageList(result.pagesWithoutText) },
                      )}
                    </small>
                  </div>
                </div>
              )}

              {result && result.ocrLayerPages.length > 0 && (
                <div className="card status-card" role="note">
                  <Info size={20} aria-hidden="true" />
                  <div className="status-card-copy">
                    <b>{t('Recognised text was used for scanned pages')}</b>
                    <small>
                      {tn(
                        result.ocrLayerPages.length,
                        'Page {pages} had a hidden text layer. Its text is editable; the scanned picture itself was left out.',
                        'Pages {pages} had a hidden text layer. Their text is editable; the scanned pictures themselves were left out.',
                        { pages: pageList(result.ocrLayerPages) },
                      )}
                    </small>
                  </div>
                </div>
              )}

              <div className="form-actions">
                <button
                  className="btn btn-primary"
                  id="pdf-to-word-run-btn"
                  onClick={() => void convert()}
                  disabled={running}
                >
                  {running ? (
                    <>
                      <Loader2 size={15} className="spin" />
                      {t('Converting…')}
                    </>
                  ) : (
                    <>
                      <FileType2 size={15} />
                      {t('Convert to Word')}
                    </>
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
