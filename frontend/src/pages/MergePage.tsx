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
import { PageHeader, Tabs } from '../components/ui';
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

      <Tabs
        ariaLabel="Merge mode"
        value={mode}
        onChange={setMode}
        items={[
          { value: 'quick', id: 'merge-mode-quick', label: 'Quick' },
          {
            value: 'folder',
            id: 'merge-mode-folder',
            label: 'Folder',
            disabled: !folderModeAvailable,
            title: folderModeAvailable ? undefined : 'Folder mode requires the desktop app',
          },
        ]}
      >
        {!folderModeAvailable && (
          <span className="organize-help">Folder mode requires the desktop app</span>
        )}
      </Tabs>

      {mode === 'folder' && <FolderWorkspace />}

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div className="page-body" hidden={mode === 'folder'}>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf"
          multiple
          hidden
          onChange={handleFileInput}
          id="merge-file-input"
        />

        {files.length === 0 ? (
          <div className="form-col form-col--center">
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
              <Upload className="drop-zone-icon" />
              <p className="drop-zone-title">Drop PDF files here</p>
              <p className="drop-zone-sub">or click to browse · Multiple files supported</p>
              <div className="badge-row">
                <span className="badge badge-neutral">PDF</span>
                <span className="badge badge-neutral">Multiple files</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="merge-quick-split">
            {/* Left: previews in merge order */}
            <div className="card merge-quick-files">
              <div className="card-title-row card-title-row--wrap">
                <FileText size={16} color="var(--accent)" />
                <span className="card-title-text">Files to Merge</span>
                <span className="badge badge-info">{files.length} file{files.length !== 1 ? 's' : ''}</span>
                {duplicateOf.size > 0 && (
                  <span className="badge badge-warning" id="merge-duplicate-note">
                    {duplicateOf.size} duplicate{duplicateOf.size !== 1 ? 's' : ''} added
                  </span>
                )}
                <span className="grow-spacer" />
                <span className="text-muted card-title-note">Drag the previews to reorder</span>
              </div>
              <SortableCardGrid
                idPrefix="merge"
                compact
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
                        className="sort-card-thumb"
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

            {/* Right: add more, output name, actions */}
            <div className="col-stack merge-quick-side">
              <div
                id="merge-drop-zone"
                className={`drop-zone drop-zone--compact${isDragOver ? ' drag-over' : ''}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={handleClick}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && handleClick()}
                aria-label="Drop PDF files here or click to browse"
              >
                <Upload className="drop-zone-icon" />
                <p className="drop-zone-title">Add more PDFs</p>
                <p className="drop-zone-sub">Drop here or click to browse</p>
              </div>

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
                <p className="text-muted text-body-sm hint-gap-sm">
                  The .pdf extension will be added automatically if omitted.
                </p>
              </div>

              {result && (
                <div className="card result-card" role="status">
                  <CheckCircle size={24} className="result-card-icon" />
                  <div className="grow">
                    <div className="result-card-title">
                      Download started automatically
                    </div>
                    <div className="result-card-meta">
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

              <div className="action-row">
                <button
                  className="btn btn-secondary"
                  id="merge-clear-btn"
                  onClick={clearAll}
                  disabled={isLoading}
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
                      <Loader2 size={15} className="spin" />
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
        )}
      </div>
    </div>
  );
}
