import { useEffect, useCallback, useRef, useState } from 'react';
import {
  CheckCircle,
  FileText,
  FolderOpen,
  Loader2,
  Save,
  Tag,
  Upload,
  X,
} from 'lucide-react';
import apiClient from '../api/client';
import { Filename } from '../components/Filename';
import { addHistoryEntry } from '../utils/historyStore';
import { PdfThumbnail } from '../components/PdfThumbnail';
import { useToast } from '../hooks/useToast';
import { useFeatureFile } from '../hooks/useFeatureFile';
import { openOutputFolder } from '../utils/tauriDialog';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PdfInfo {
  filename: string;
  total_pages: number;
  file_size_bytes: number;
  metadata?: {
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string;
  };
}


interface MetadataResult {
  blobUrl: string;
  filename: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}


// ── Component ─────────────────────────────────────────────────────────────────

export function MetadataPage() {
  const { showToast } = useToast();
  const { fileData: file, setFileData: setFile } = useFeatureFile<File | null>('metadata');
  const [pdfInfo, setPdfInfo] = useState<PdfInfo | null>(null);
  
  // Form State
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [subject, setSubject] = useState('');
  const [keywords, setKeywords] = useState('');

  const [infoLoading, setInfoLoading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<MetadataResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);


  // ── File handling ───────────────────────────────────────────────────────────
  const loadFile = useCallback(
    async (f: File) => {
      if (!f.name.toLowerCase().endsWith('.pdf')) {
        showToast({ type: 'error', title: 'Invalid file', message: 'Only PDF files are accepted.' });
        return;
      }
      setFile(f);
      setPdfInfo(null);
      setResult(null);
      setInfoLoading(true);

      // Reset form
      setTitle('');
      setAuthor('');
      setSubject('');
      setKeywords('');

      try {
        const form = new FormData();
        form.append('file', f);
        const resp = await apiClient.post<{ status: string; data: PdfInfo }>('/api/v1/pdf-info/', form);
        const info = resp.data.data;
        setPdfInfo(info);
        
        if (info.metadata) {
          setTitle(info.metadata.title || '');
          setAuthor(info.metadata.author || '');
          setSubject(info.metadata.subject || '');
          setKeywords(info.metadata.keywords || '');
        }
      } catch {
        showToast({ type: 'error', title: 'PDF load failed', message: 'Could not read metadata.' });
        setFile(null);
      } finally {
        setInfoLoading(false);
      }
    },
    []
  );
  useEffect(() => {
    if (file && !pdfInfo && !infoLoading && !result) {
      loadFile(file);
    }
  }, [file, pdfInfo, infoLoading, result, loadFile]);

  useEffect(() => {
    return () => {
      if (result?.blobUrl) {
        URL.revokeObjectURL(result.blobUrl);
      }
    };
  }, [result?.blobUrl]);

  const handleDragOverFile = (e: React.DragEvent) => { e.preventDefault(); setIsDragOver(true); };
  const handleDragLeaveFile = () => setIsDragOver(false);
  const handleDropFile = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) loadFile(dropped);
  };
  const handleClick = () => fileInputRef.current?.click();
  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) loadFile(e.target.files[0]);
    e.target.value = '';
  };

  // ── Submit ──────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!file) { showToast({ type: 'error', title: 'No file', message: 'Please select a PDF file first.' }); return; }
    
    setIsLoading(true);
    setResult(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('title', title);
    formData.append('author', author);
    formData.append('subject', subject);
    formData.append('keywords', keywords);

    try {
      const response = await apiClient.post('/api/v1/metadata/', formData, { responseType: 'blob' });

      const blob = new Blob([response.data], { type: 'application/pdf' });
      const blobUrl = URL.createObjectURL(blob);
      
      const getOutputFilename = (): string => {
        const t = title.trim();
        if (t) {
          return t.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').substring(0, 100) + '.pdf';
        }
        return file.name.replace('.pdf', '') + '_metadata.pdf';
      };
      
      let filename = getOutputFilename();
      if (response.headers['content-disposition']) {
        const match = response.headers['content-disposition'].match(/filename="([^"]+)"/);
        if (match) filename = match[1];
      } else if (response.headers['x-output-file']) {
        filename = response.headers['x-output-file'];
      }

      setResult({ blobUrl, filename });
      addHistoryEntry({ filename, action: 'Updated Metadata', size: 0 });

      // Auto-download
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      a.click();

      showToast({
        type: 'success',
        title: 'Metadata updated!',
        message: `Saved as ${filename}`,
        action: { label: 'Open Folder', onClick: openOutputFolder },
        duration: 8000,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      showToast({ type: 'error', title: 'Update failed', message: msg });
    } finally {
      setIsLoading(false);
    }
  };

  const clearFile = () => { setFile(null); setPdfInfo(null); setResult(null); };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: 36, height: 36, borderRadius: 'var(--radius-md)',
            background: 'var(--accent-dim)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', color: 'var(--accent)',
          }}>
            <Tag size={20} strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="page-title">Edit Metadata</h1>
            <p className="page-subtitle">View and update PDF document properties</p>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="page-body">
        <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Drop zone */}
          {!file ? (
            <div
              id="metadata-drop-zone"
              className={`drop-zone${isDragOver ? ' drag-over' : ''}`}
              onDragOver={handleDragOverFile}
              onDragLeave={handleDragLeaveFile}
              onDrop={handleDropFile}
              onClick={handleClick}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && handleClick()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                style={{ display: 'none' }}
                onChange={handleFileInput}
              />
              <Upload className="drop-zone-icon" />
              <p className="drop-zone-title">Drop a PDF file here</p>
              <p className="drop-zone-sub">or click to browse · Single PDF</p>
            </div>
          ) : (
            <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <PdfThumbnail file={file} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <Filename name={file.name} className="file-item-name" />
                <div className="file-item-meta" style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 4 }}>
                  <span>{formatBytes(file.size)}</span>
                  {infoLoading && <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />}
                  {pdfInfo && (
                    <span className="badge badge-info" style={{ fontSize: 11 }}>
                      {pdfInfo.total_pages} pages
                    </span>
                  )}
                </div>
              </div>
              <button
                className="btn btn-ghost btn-icon btn-sm"
                onClick={clearFile}
                style={{ color: 'var(--error)' }}
              >
                <X size={15} />
              </button>
            </div>
          )}

          {/* Form Area */}
          {file && !infoLoading && (
            <div className="card">
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                <FileText size={16} color="var(--accent)" /> Document Properties
              </div>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                  <label className="input-label">Title</label>
                  <input
                    className="input"
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Document Title"
                  />
                  <p style={{ fontSize: '12px', color: '#888', marginTop: '4px' }}>
                    Nama file output akan mengikuti Title.
                    Kosongkan untuk mempertahankan nama asli.
                  </p>
                </div>
                <div>
                  <label className="input-label">Author</label>
                  <input
                    className="input"
                    type="text"
                    value={author}
                    onChange={(e) => setAuthor(e.target.value)}
                    placeholder="Author Name"
                  />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label className="input-label">Subject</label>
                  <input
                    className="input"
                    type="text"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="Subject of the document"
                  />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label className="input-label">Keywords</label>
                  <input
                    className="input"
                    type="text"
                    value={keywords}
                    onChange={(e) => setKeywords(e.target.value)}
                    placeholder="Comma-separated keywords (e.g. invoice, 2026, tech)"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Result */}
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
                  Metadata Updated
                </div>
                <div style={{ fontSize: 12, color: 'var(--on-surface-variant)' }}>
                  <Filename name={result.filename} />
                </div>
              </div>
              <button
                className="btn btn-secondary btn-sm"
                onClick={openOutputFolder}
              >
                <FolderOpen size={14} />
                Open Folder
              </button>
            </div>
          )}

          {/* Actions */}
          {file && (
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button
                className="btn btn-secondary"
                onClick={clearFile}
                disabled={isLoading}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSave}
                disabled={isLoading}
              >
                {isLoading ? (
                  <>
                    <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
                    Saving…
                  </>
                ) : (
                  <>
                    <Save size={15} />
                    Save Metadata
                  </>
                )}
              </button>
            </div>
          )}

        </div>
      </div>

      

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
