import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle,
  FolderOpen,
  Loader2,
  RotateCw,
  Trash2,
  Upload,
  X,
  Image as ImageIcon,
} from 'lucide-react';
import apiClient from '../api/client';
import type { ImageToPdfResult } from '../types';
import { Filename } from '../components/Filename';
import { addHistoryEntry } from '../utils/historyStore';
import { PreviewPanel } from '../components/preview';
import { useToast } from '../hooks/useToast';
import { useFeatureFile } from '../hooks/useFeatureFile';
import { getFilenameFromHeaders, triggerBlobDownload } from '../utils/downloadHelper';
import { openOutputFolder } from '../utils/tauriDialog';


// ── Types ─────────────────────────────────────────────────────────────────────

interface FileEntry {
  id: string;
  file: File;
  previewUrl: string;
  rotation: number;
  flipH: boolean;
}


// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE_OPTIONS = [
  { value: 'a4', label: 'A4', desc: 'Standard (595×842)' },
  { value: 'a3', label: 'A3', desc: 'Large (842×1191)' },
  { value: 'letter', label: 'Letter', desc: 'US (612×792)' },
  { value: 'legal', label: 'Legal', desc: 'US (612×1008)' },
  { value: 'match_image', label: 'Match Image', desc: 'Use original size' },
];

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/tiff'];

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

export function ImageToPdfPage() {
  const { showToast } = useToast();
  const { fileData: _files, setFileData: setFiles } = useFeatureFile<FileEntry[]>('imagetopdf');
  const files = _files || [];
  const [outputName, setOutputName] = useState('output.pdf');
  const [pageSize, setPageSize] = useState('a4');
  const [isDragOver, setIsDragOver] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<ImageToPdfResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Preview state
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1.0);

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      files.forEach((f) => URL.revokeObjectURL(f.previewUrl));
    };
  }, [files]);

  // Handle active index reset when files change
  useEffect(() => {
    if (files.length === 0) {
      setActiveIdx(null);
    } else if (activeIdx !== null && activeIdx >= files.length) {
      setActiveIdx(files.length - 1);
    }
  }, [files, activeIdx]);


  // ── File handling ───────────────────────────────────────────────────────────
  const addFiles = useCallback(
    (incoming: File[]) => {
      const validImages = incoming.filter((f) => ACCEPTED_TYPES.includes(f.type));
      if (validImages.length !== incoming.length) {
        showToast({ type: 'error', title: 'Invalid files', message: 'Some files were skipped. Only images are allowed.' });
      }
      if (validImages.length === 0) return;
      
      const newEntries: FileEntry[] = validImages.map((f) => ({
        id: generateId(),
        file: f,
        previewUrl: URL.createObjectURL(f),
        rotation: 0,
        flipH: false,
      }));
      
      setFiles((prev) => {
        const safePrev = prev || [];
        const next = [...safePrev, ...newEntries];
        if (safePrev.length === 0) setActiveIdx(0); // auto-select first file
        return next;
      });
      setResult(null);
    },
    []
  );

  const removeFile = (id: string) => {
    setFiles((prev) => {
      if (!prev) return [];
      const filtered = prev.filter((f) => {
        if (f.id === id) {
          URL.revokeObjectURL(f.previewUrl);
          return false;
        }
        return true;
      });
      return filtered;
    });
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

      // Track active index movement
      if (activeIdx === idx) {
        setActiveIdx(swapIdx);
      } else if (activeIdx === swapIdx) {
        setActiveIdx(idx);
      }

      return newArr;
    });
  };

  const rotateFile = (id: string, newRotation?: 0|90|180|270) => {
    setFiles((prev) => {
      if (!prev) return [];
      return prev.map((f) =>
        f.id === id ? { ...f, rotation: newRotation !== undefined ? newRotation : (f.rotation + 90) % 360 } : f
      );
    });
  };

  const flipFile = (id: string) => {
    setFiles((prev) => {
      if (!prev) return [];
      return prev.map((f) => (f.id === id ? { ...f, flipH: !f.flipH } : f));
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

  // ── Submit ──────────────────────────────────────────────────────────────────
  const handleConvert = async () => {
    if (files.length === 0) {
      showToast({ type: 'error', title: 'No files', message: 'Add at least one image file.' });
      return;
    }
    setIsLoading(true);
    setResult(null);

    const formData = new FormData();
    files.forEach((entry) => formData.append('files', entry.file));
    formData.append('output_filename', outputName || 'output.pdf');
    formData.append('page_size', pageSize);
    
    formData.append('rotations', JSON.stringify(files.map((e) => e.rotation)));
    formData.append('flips', JSON.stringify(files.map((e) => e.flipH)));

    try {
      const response = await apiClient.post('/api/v1/image-to-pdf/', formData, {
        responseType: 'blob',
      });

      const blob = new Blob([response.data], { type: 'application/pdf' });

      const totalPages = parseInt(response.headers['x-total-pages'] || '0', 10);
      const resPageSize = response.headers['x-page-size'] || pageSize.toUpperCase();
      const filename = getFilenameFromHeaders(response.headers, outputName || 'output.pdf');
      const fileSizeBytes = blob.size;

      // Auto-download immediately
      triggerBlobDownload(blob, filename);

      setResult({ filename, totalPages, pageSize: resPageSize, fileSizeBytes });
      addHistoryEntry({ filename, action: 'Image to PDF', size: fileSizeBytes });
      showToast({
        type: 'success',
        title: 'Conversion complete!',
        message: `${totalPages} images converted → ${formatBytes(fileSizeBytes)}`,
        action: { label: 'Open Folder', onClick: () => openOutputFolder() },
        duration: 8000,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      showToast({ type: 'error', title: 'Conversion failed', message: msg });
    } finally {
      setIsLoading(false);
    }
  };

  const clearAll = () => {
    files.forEach((f) => URL.revokeObjectURL(f.previewUrl));
    setFiles([]);
    setResult(null);
    setActiveIdx(null);
  };

  const activeFile = activeIdx !== null ? files[activeIdx] : null;

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
            <ImageIcon size={20} strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="page-title">Image to PDF</h1>
            <p className="page-subtitle">Convert and combine images into a PDF document</p>
          </div>
        </div>
      </div>

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div className="page-body">
        <div className="feature-split-layout">
          
          {/* Controls */}
          <div className="feature-controls">
            {/* Drop zone */}
            <div
              id="img-to-pdf-drop-zone"
              className={`drop-zone${isDragOver ? ' drag-over' : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={handleClick}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && handleClick()}
              aria-label="Drop images here or click to browse"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".jpg,.jpeg,.png,.webp,.bmp,.tiff"
                multiple
                style={{ display: 'none' }}
                onChange={handleFileInput}
                id="img-to-pdf-file-input"
              />
              <Upload className="drop-zone-icon" />
              <p className="drop-zone-title">Drop images here</p>
              <p className="drop-zone-sub">or click to browse · Supports JPG, PNG, WEBP, TIFF</p>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <span className="badge badge-neutral">Images</span>
                <span className="badge badge-neutral">Multiple files</span>
              </div>
            </div>

            {/* File list */}
            {files.length > 0 && (
              <div className="card">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                  <ImageIcon size={16} color="var(--accent)" />
                  <span style={{ fontWeight: 600, fontSize: 14 }}>Images to Convert</span>
                  <span className="badge badge-info">{files.length} file{files.length !== 1 ? 's' : ''}</span>
                  <span style={{ flex: 1 }} />
                  <span className="text-muted" style={{ fontSize: 12 }}>Drag ↑↓ to reorder</span>
                </div>
                <div className="file-list">
                  {files.map((entry, idx) => (
                    <div 
                      key={entry.id} 
                      className="file-item"
                      style={{ 
                        backgroundColor: activeIdx === idx ? 'var(--bg-inset)' : undefined,
                        borderColor: activeIdx === idx ? 'var(--accent)' : undefined,
                        cursor: 'pointer'
                      }}
                      onClick={() => setActiveIdx(idx)}
                    >
                      <div className="file-item-icon" style={{ padding: 2, background: 'none' }}>
                        <img 
                          src={entry.previewUrl} 
                          alt={entry.file.name} 
                          style={{ 
                            width: '100%', 
                            height: '100%', 
                            objectFit: 'cover', 
                            borderRadius: '4px',
                            transform: `rotate(${entry.rotation}deg) ${entry.flipH ? 'scaleX(-1)' : ''}`,
                            transition: 'transform 0.2s ease-in-out'
                          }} 
                        />
                      </div>
                      <div className="file-item-info">
                        <Filename name={entry.file.name} className="file-item-name" />
                        <div className="file-item-meta">{formatBytes(entry.file.size)}</div>
                      </div>
                      <span className="badge badge-neutral" style={{ marginRight: 8 }}>#{idx + 1}</span>
                      <div className="file-item-actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          onClick={() => rotateFile(entry.id)}
                          aria-label="Rotate image"
                          title="Rotate 90°"
                        >
                          <RotateCw size={14} />
                        </button>
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          onClick={() => flipFile(entry.id)}
                          aria-label="Flip image"
                          title="Flip Horizontal"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20v-16M8 4L4 12l4 8M16 4l4 8-4 8"/></svg>
                        </button>
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          onClick={() => moveFile(entry.id, 'up')}
                          disabled={idx === 0}
                          aria-label="Move up"
                          id={`img-move-up-${idx}`}
                        >
                          <ArrowUp size={14} />
                        </button>
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          onClick={() => moveFile(entry.id, 'down')}
                          disabled={idx === files.length - 1}
                          aria-label="Move down"
                          id={`img-move-down-${idx}`}
                        >
                          <ArrowDown size={14} />
                        </button>
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          onClick={() => removeFile(entry.id)}
                          aria-label="Remove file"
                          id={`img-remove-${idx}`}
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

            {/* Settings Grid */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {/* Page Size */}
              <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
                <label className="input-label">Page Size</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 4 }}>
                  {PAGE_SIZE_OPTIONS.map((opt) => (
                    <label
                      key={opt.value}
                      htmlFor={`pagesize-${opt.value}`}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 12,
                        padding: '10px 14px',
                        borderRadius: 'var(--radius-md)',
                        border: `1px solid ${pageSize === opt.value ? 'var(--accent)' : 'var(--outline-variant)'}`,
                        background: pageSize === opt.value ? 'var(--accent-dim)' : 'var(--surface-container)',
                        cursor: 'pointer',
                        transition: 'all var(--transition-fast)',
                        gridColumn: opt.value === 'match_image' ? '1 / -1' : 'auto',
                        height: '100%',
                      }}
                    >
                      <div style={{ paddingTop: 1, flexShrink: 0 }}>
                        <input
                          id={`pagesize-${opt.value}`}
                          type="radio"
                          name="pageSize"
                          value={opt.value}
                          checked={pageSize === opt.value}
                          onChange={() => setPageSize(opt.value)}
                          style={{ margin: 0, accentColor: 'var(--accent)' }}
                        />
                      </div>
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start' }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--on-surface)', lineHeight: 1.4 }}>{opt.label}</div>
                        <div style={{ fontSize: 12, color: 'var(--on-surface-variant)', marginTop: 2, lineHeight: 1.4 }}>{opt.desc}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* Output filename */}
              <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
                <label className="input-label" htmlFor="img-output-name">Output Filename</label>
                <input
                  id="img-output-name"
                  className="input"
                  type="text"
                  value={outputName}
                  onChange={(e) => setOutputName(e.target.value)}
                  placeholder="output.pdf"
                  style={{ flex: 1, maxHeight: 42 }}
                />
                <p className="text-muted text-body-sm" style={{ marginTop: 12 }}>
                  The .pdf extension will be added automatically if omitted.
                </p>
              </div>
            </div>

            {/* Result card */}
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
                    <Filename name={result.filename} /> · {result.totalPages} pages · {result.pageSize} · {formatBytes(result.fileSizeBytes)}
                  </div>
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  id="img-open-folder-btn"
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
                id="img-clear-btn"
                onClick={clearAll}
                disabled={files.length === 0 || isLoading}
              >
                <Trash2 size={15} />
                Clear All
              </button>
              <button
                className="btn btn-primary"
                id="img-run-btn"
                onClick={handleConvert}
                disabled={files.length === 0 || isLoading}
              >
                {isLoading ? (
                  <>
                    <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
                    Converting…
                  </>
                ) : (
                  <>
                    <ImageIcon size={15} />
                    Convert & Download
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Preview Panel */}
          <div className="feature-preview">
            <PreviewPanel
              imageFile={activeFile?.file}
              zoom={zoom}
              onZoomChange={setZoom}
              showRotation={!!activeFile}
              rotation={activeFile?.rotation as 0 | 90 | 180 | 270}
              flipH={activeFile?.flipH}
              onRotationChange={(r) => activeFile && rotateFile(activeFile.id, r)}
              onFlipChange={() => activeFile && flipFile(activeFile.id)}
              currentPage={1} // Unused for image mode but required by props type
              onPageChange={() => {}}
            />
          </div>

        </div>
      </div>

      

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
