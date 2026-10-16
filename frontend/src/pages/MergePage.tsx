import { useCallback, useRef, useState } from 'react';
import {
  CheckCircle,
  FileText,
  FolderOpen,
  Loader2,
  Merge,
  Trash2,
  Upload,
} from 'lucide-react';
import apiClient from '../api/client';
import { Filename } from '../components/Filename';
import { addHistoryEntry } from '../utils/historyStore';
import { PdfThumbnail } from '../components/PdfThumbnail';
import { PageHeader } from '../components/ui';
import { useToast } from '../hooks/useToast';
import { useFeatureFile } from '../hooks/useFeatureFile';
import { SortableCardGrid } from '../components/sortable/SortableCardGrid';
import { FolderWorkspace } from '../features/merge/FolderWorkspace';
import { isTauri } from '../utils/tauriDialog';
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
  // Quick and Folder keep their own state; toggling never clears either side.
  const [mode, setMode] = useState<'quick' | 'folder'>('quick');
  const folderModeAvailable = isTauri();
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

  /** Moves a file to a new position; used by dragging, the arrow buttons, and Alt+Arrow. */
  const reorderFiles = useCallback((from: number, to: number) => {
    setFiles((prev) => {
      if (!prev) return [];
      if (from < 0 || to < 0 || from >= prev.length || to >= prev.length || from === to) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, [setFiles]);

  /** Files that repeat an earlier file's name and size are marked, not blocked. */
  const duplicateOf = new Map<string, number>();
  {
    const firstSeen = new Map<string, number>();
    files.forEach((entry, idx) => {
      const key = `${entry.file.name.toLowerCase()}|${entry.file.size}`;
      const first = firstSeen.get(key);
      if (first === undefined) firstSeen.set(key, idx);
      else duplicateOf.set(entry.id, first);
    });
  }

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
    <div className="feature-page">
      <PageHeader
        icon={Merge}
        title="Merge PDF"
        description="Combine multiple PDF files into one document"
      />

      <div className="tabs" role="tablist" aria-label="Merge mode">
        <button
          type="button"
          role="tab"
          id="merge-mode-quick"
          aria-selected={mode === 'quick'}
          className={`tab${mode === 'quick' ? ' active' : ''}`}
          onClick={() => setMode('quick')}
        >
          Quick
        </button>
        <button
          type="button"
          role="tab"
          id="merge-mode-folder"
          aria-selected={mode === 'folder'}
          className={`tab${mode === 'folder' ? ' active' : ''}`}
          onClick={() => setMode('folder')}
          disabled={!folderModeAvailable}
          title={folderModeAvailable ? undefined : 'Folder mode requires the desktop app'}
        >
          Folder
        </button>
        {!folderModeAvailable && (
          <span className="organize-help">Folder mode requires the desktop app</span>
        )}
      </div>

      {mode === 'folder' && <FolderWorkspace />}

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div className="page-body" hidden={mode === 'folder'}>
        <div className="form-col">

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
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                <FileText size={16} color="var(--accent)" />
                <span style={{ fontWeight: 600, fontSize: 14 }}>Files to Merge</span>
                <span className="badge badge-info">{files.length} file{files.length !== 1 ? 's' : ''}</span>
                {duplicateOf.size > 0 && (
                  <span className="badge badge-warning" id="merge-duplicate-note">
                    {duplicateOf.size} duplicate{duplicateOf.size !== 1 ? 's' : ''} added
                  </span>
                )}
                <span style={{ flex: 1 }} />
                <span className="text-muted" style={{ fontSize: 12 }}>Drag the previews to reorder</span>
              </div>
              <SortableCardGrid
                idPrefix="merge"
                ariaLabel="Files to merge, in merge order"
                disabled={isLoading}
                onReorder={reorderFiles}
                onRemove={removeFile}
                cards={files.map((entry) => {
                  const first = duplicateOf.get(entry.id);
                  return {
                    id: entry.id,
                    title: entry.file.name,
                    thumbnail: (
                      <PdfThumbnail
                        file={entry.file}
                        style={{ width: '66%', height: '86%', border: '1px solid var(--line)', borderRadius: 3, background: '#fff' }}
                      />
                    ),
                    meta: (
                      <>
                        <span>{formatBytes(entry.file.size)}</span>
                        {entry.pages !== undefined && <span>{entry.pages} page{entry.pages !== 1 ? 's' : ''}</span>}
                      </>
                    ),
                    warning: first === undefined
                      ? undefined
                      : `Same name and size as #${first + 1}. It is still included in the merge.`,
                  };
                })}
              />
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

      

    </div>
  );
}
