import { useCallback, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle,
  FileText,
  FolderOpen,
  Loader2,
  Merge,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import apiClient from '../api/client';
import { Filename } from '../components/Filename';
import { addHistoryEntry } from '../utils/historyStore';
import { PdfThumbnail } from '../components/PdfThumbnail';
import { useToast } from '../hooks/useToast';
import { useFeatureFile } from '../hooks/useFeatureFile';
import { getFilenameFromHeaders, triggerBlobDownload } from '../utils/downloadHelper';
import { openOutputFolder } from '../utils/tauriDialog';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PdfInfo {
  filename: string;
  total_pages: number;
  file_size_bytes: number;
}

interface FileEntry {
  id: string;
  file: File;
  pages?: number;
}


interface MergeResult {
  filename: string;
  totalPages: number;
  sizeBytes: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}


// ── Component ─────────────────────────────────────────────────────────────────

export function MergePage() {
  const { showToast } = useToast();
  const { fileData: _files, setFileData: setFiles } = useFeatureFile<FileEntry[]>('merge');
  const files = _files || [];
  const [outputName, setOutputName] = useState('merged_output.pdf');
  const [isDragOver, setIsDragOver] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<MergeResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);


  // ── File handling ───────────────────────────────────────────────────────────
  const addFiles = useCallback(
    async (incoming: File[]) => {
      const pdfs = incoming.filter((f) => f.name.toLowerCase().endsWith('.pdf'));
      if (pdfs.length !== incoming.length) {
        showToast({ type: 'error', title: 'Invalid files', message: 'Only PDF files are accepted.' });
      }
      if (pdfs.length === 0) return;
      
      const newEntries: FileEntry[] = pdfs.map((f) => ({ id: generateId(), file: f, pages: undefined }));
      setFiles((prev) => [
        ...(prev || []),
        ...newEntries,
      ]);
      setResult(null);

      // Fetch page counts
      for (const entry of newEntries) {
        try {
          const form = new FormData();
          form.append('file', entry.file);
          const resp = await apiClient.post<{ status: string; data: PdfInfo }>('/api/v1/pdf-info/', form);
          setFiles((prev) => {
            if (!prev) return prev;
            return prev.map((p) => p.id === entry.id ? { ...p, pages: resp.data.data.total_pages } : p);
          });
        } catch {
          // fail silently for individual files
        }
      }
    },
    [setFiles, showToast]
  );

  const removeFile = (id: string) => {
    setFiles((prev) => prev ? prev.filter((f) => f.id !== id) : []);
    setResult(null);
  };

  const moveFile = (id: string, direction: 'up' | 'down') => {
    setFiles((prev) => {
      if (!prev) return [];
      const idx = prev.findIndex((f) => f.id === id);
      if (idx === -1) return prev;
      const newArr = [...prev];
      const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= newArr.length) return prev;
      [newArr[idx], newArr[swapIdx]] = [newArr[swapIdx], newArr[idx]];
      return newArr;
    });
  };

  // ── Drag & drop ─────────────────────────────────────────────────────────────
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };
  const handleDragLeave = () => setIsDragOver(false);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    addFiles(Array.from(e.dataTransfer.files));
  };
  const handleClick = () => fileInputRef.current?.click();
  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(Array.from(e.target.files));
    e.target.value = '';
  };

  // ── Submit — single-step: process & download immediately ───────────────────
  const handleMerge = async () => {
    if (files.length < 2) {
      showToast({ type: 'error', title: 'Not enough files', message: 'Add at least 2 PDF files to merge.' });
      return;
    }
    setIsLoading(true);
    setResult(null);

    const formData = new FormData();
    files.forEach((entry) => formData.append('files', entry.file));
    formData.append('output_filename', outputName || 'merged_output.pdf');

    try {
      const response = await apiClient.post('/api/v1/merge/', formData, {
        responseType: 'blob',
      });

      const blob = new Blob([response.data], { type: 'application/pdf' });
      const totalPages = parseInt(response.headers['x-total-pages'] || '0', 10);
      const sizeBytes = parseInt(response.headers['x-file-size'] || String(blob.size), 10);
      const filename = getFilenameFromHeaders(response.headers, outputName || 'merged_output.pdf');

      // Auto-download immediately
      triggerBlobDownload(blob, filename);

      setResult({ filename, totalPages, sizeBytes });
      addHistoryEntry({ filename, action: 'Merged PDF', size: sizeBytes });
      showToast({
        type: 'success',
        title: 'Merge complete!',
        message: `${filename} — ${totalPages} pages, ${formatBytes(sizeBytes)}`,
        action: { label: 'Open Folder', onClick: () => openOutputFolder() },
        duration: 8000,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      showToast({ type: 'error', title: 'Merge failed', message: msg });
    } finally {
      setIsLoading(false);
    }
  };

  const clearAll = () => {
    setFiles([]);
    setResult(null);
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
            <Merge size={20} strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="page-title">Merge PDF</h1>
            <p className="page-subtitle">Combine multiple PDF files into one document</p>
          </div>
        </div>
      </div>

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div className="page-body">
        <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Drop zone */}
          <div
            id="merge-drop-zone"
            className={`drop-zone${isDragOver ? ' drag-over' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={handleClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && handleClick()}
            aria-label="Drop PDF files here or click to browse"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileInput}
              id="merge-file-input"
            />
            <Upload className="drop-zone-icon" />
            <p className="drop-zone-title">Drop PDF files here</p>
            <p className="drop-zone-sub">or click to browse · Multiple files supported</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <span className="badge badge-neutral">PDF</span>
              <span className="badge badge-neutral">Multiple files</span>
            </div>
          </div>

          {/* File list */}
          {files.length > 0 && (
            <div className="card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <FileText size={16} color="var(--accent)" />
                <span style={{ fontWeight: 600, fontSize: 14 }}>Files to Merge</span>
                <span className="badge badge-info">{files.length} file{files.length !== 1 ? 's' : ''}</span>
                <span style={{ flex: 1 }} />
                <span className="text-muted" style={{ fontSize: 12 }}>Drag ↑↓ to reorder</span>
              </div>
              <div className="file-list">
                {files.map((entry, idx) => (
                  <div key={entry.id} className="file-item">
                    <PdfThumbnail file={entry.file} />
                    <div className="file-item-info">
                      <Filename name={entry.file.name} className="file-item-name" />
                      <div className="file-item-meta" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span>{formatBytes(entry.file.size)}</span>
                        {entry.pages !== undefined && (
                          <span className="badge badge-info" style={{ fontSize: 10 }}>
                            {entry.pages} pages
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="badge badge-neutral" style={{ marginRight: 8 }}>#{idx + 1}</span>
                    <div className="file-item-actions">
                      <button
                        className="btn btn-ghost btn-icon btn-sm"
                        onClick={() => moveFile(entry.id, 'up')}
                        disabled={idx === 0}
                        aria-label="Move up"
                        id={`merge-move-up-${idx}`}
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        className="btn btn-ghost btn-icon btn-sm"
                        onClick={() => moveFile(entry.id, 'down')}
                        disabled={idx === files.length - 1}
                        aria-label="Move down"
                        id={`merge-move-down-${idx}`}
                      >
                        <ArrowDown size={14} />
                      </button>
                      <button
                        className="btn btn-ghost btn-icon btn-sm"
                        onClick={() => removeFile(entry.id)}
                        aria-label="Remove file"
                        id={`merge-remove-${idx}`}
                        style={{ color: 'var(--error)' }}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {files.length === 0 && (
            <div className="card" style={{ textAlign: 'center', padding: '32px 20px' }}>
              <FileText size={32} style={{ color: 'var(--outline)', margin: '0 auto 12px' }} />
              <p className="text-muted text-body-sm">No files added yet. Drop PDFs above to get started.</p>
            </div>
          )}

          {/* Output filename */}
          <div className="card">
            <label className="input-label" htmlFor="merge-output-name">Output Filename</label>
            <input
              id="merge-output-name"
              className="input"
              type="text"
              value={outputName}
              onChange={(e) => setOutputName(e.target.value)}
              placeholder="merged_output.pdf"
            />
            <p className="text-muted text-body-sm" style={{ marginTop: 6 }}>
              The .pdf extension will be added automatically if omitted.
            </p>
          </div>

          {/* Result card — download was triggered automatically */}
          {result && (
            <div
              className="card"
              style={{
                background: 'var(--success-container)',
                border: '1px solid var(--success)',
                display: 'flex', alignItems: 'center', gap: 16,
              }}
            >
              <CheckCircle size={28} color="var(--success)" style={{ flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--success)', marginBottom: 4 }}>
                  Download started automatically
                </div>
                <div style={{ fontSize: 12, color: 'var(--on-surface-variant)' }}>
                  <Filename name={result.filename} /> · {result.totalPages} pages · {formatBytes(result.sizeBytes)}
                </div>
              </div>
              <button
                className="btn btn-ghost btn-sm"
                id="merge-open-folder-btn"
                onClick={() => openOutputFolder()}
                title="Open download folder"
              >
                <FolderOpen size={14} />
                Open Folder
              </button>
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
            <button
              className="btn btn-secondary"
              id="merge-clear-btn"
              onClick={clearAll}
              disabled={files.length === 0 || isLoading}
            >
              <Trash2 size={15} />
              Clear All
            </button>
            <button
              className="btn btn-primary"
              id="merge-run-btn"
              onClick={handleMerge}
              disabled={files.length < 2 || isLoading}
            >
              {isLoading ? (
                <>
                  <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
                  Merging…
                </>
              ) : (
                <>
                  <Merge size={15} />
                  Merge & Download
                </>
              )}
            </button>
          </div>

        </div>
      </div>

      

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
