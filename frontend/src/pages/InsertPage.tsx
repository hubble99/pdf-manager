import React, { useCallback, useRef, useState, useEffect } from 'react';
import {
  CheckCircle,
  FolderOpen,
  FilePlus2,
  Loader2,
  Plus,
  Upload,
  X,
} from 'lucide-react';
import apiClient from '../api/client';
import { Filename } from '../components/Filename';
import { addHistoryEntry } from '../utils/historyStore';
import { PdfThumbnail } from '../components/PdfThumbnail';
import { PreviewPanel } from '../components/preview';
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


interface InsertionRule {
  ruleId: string;
  targetPage: number;
  insertMode: 'before' | 'after' | 'replace';
  sourceType: 'image' | 'pdf';
  sourceFile: File;
  previewUrl?: string;
  sourcePages: string;
  originalIndex: number;
  rotation: number;
  flipH: boolean;
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
export function InsertPage() {
  const { showToast } = useToast();
  const { fileData: file, setFileData: setFile } = useFeatureFile<File | null>('insert');
  const [pdfInfo, setPdfInfo] = useState<PdfInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  
  const [rules, setRules] = useState<InsertionRule[]>([]);
  const rulesRef = useRef(rules);
  useEffect(() => { rulesRef.current = rules; }, [rules]);

  useEffect(() => {
    return () => {
      rulesRef.current.forEach(r => {
        if (r.previewUrl && typeof r.previewUrl === 'string') {
          URL.revokeObjectURL(r.previewUrl);
        }
      });
    };
  }, []);

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<{ filename: string; pages: number } | null>(null);
  const [outputFilename, setOutputFilename] = useState('');
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Preview State
  const [previewPage, setPreviewPage] = useState(1);
  const [zoom, setZoom] = useState(1.0);

  // Dialog State
  const [dialogSourceFile, setDialogSourceFile] = useState<File | null>(null);
  const [dialogMode, setDialogMode] = useState<'before' | 'after' | 'replace'>('after');
  const [dialogTargetPage, setDialogTargetPage] = useState<number>(1);
  const [dialogSourcePages, setDialogSourcePages] = useState<string>('');
  const [dialogRotation, setDialogRotation] = useState<0|90|180|270>(0);
  const [dialogFlipH, setDialogFlipH] = useState<boolean>(false);
  const [dialogSourceMode, setDialogSourceMode] = useState<'all' | 'custom'>('all');
  const [dialogSourcePage, setDialogSourcePage] = useState(1);
  const [dialogSourceZoom, setDialogSourceZoom] = useState(1.0);
  const [dialogSourceTotalPages, setDialogSourceTotalPages] = useState<number | undefined>(undefined);
  const dialogFileInputRef = useRef<HTMLInputElement>(null);


  // ── Main File Handling ──────────────────────────────────────────────────────
  

const loadFile = useCallback(
    async (f: File) => {
      if (!f.name.toLowerCase().endsWith('.pdf')) {
        showToast({ type: 'error', title: 'Invalid file', message: 'Only PDF files are accepted.' });
        return;
      }
      setFile(f);
      setPdfInfo(null);
      setResult(null);
      setRules([]); // clear rules when main file changes
      setPreviewPage(1);
      setInfoLoading(true);
      setOutputFilename(`inserted_${f.name}`);

      try {
        const form = new FormData();
        form.append('file', f);
        const resp = await apiClient.post<{ status: string; data: PdfInfo }>('/api/v1/pdf-info/', form);
        setPdfInfo(resp.data.data);
      } catch {
        showToast({ type: 'info', title: 'PDF info unavailable', message: 'Could not read page count — backend may be offline.' });
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

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragOver(true); };
  const handleDragLeave = () => setIsDragOver(false);
  const handleDrop = (e: React.DragEvent) => {
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

  const clearFile = () => { 
    setFile(null); setPdfInfo(null); setResult(null); 
    rules.forEach(r => { if (r.previewUrl) URL.revokeObjectURL(r.previewUrl); });
    setRules([]); 
  };

  // ── Dialog Handlers ─────────────────────────────────────────────────────────
  const openDialog = () => {
    setDialogSourceFile(null);
    setDialogMode('after');
    setDialogTargetPage(previewPage || 1);
    setDialogSourcePages('');
    setDialogRotation(0);
    setDialogFlipH(false);
    setDialogSourceMode('all');
    setDialogSourcePage(1);
    setDialogSourceZoom(1.0);
    setDialogSourceTotalPages(undefined);
    setIsDialogOpen(true);
  };

  const closeDialog = () => {
    setIsDialogOpen(false);
  };

  const handleDialogFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setDialogSourceFile(f);
      setDialogRotation(0);
      setDialogFlipH(false);
      setDialogSourceMode('all');
      
      if (f.name.toLowerCase().endsWith('.pdf')) {
        setDialogSourceTotalPages(undefined);
        setDialogSourcePage(1);
        try {
          const form = new FormData();
          form.append('file', f);
          const resp = await apiClient.post<{ status: string; data: PdfInfo }>('/api/v1/pdf-info/', form);
          setDialogSourceTotalPages(resp.data.data.total_pages);
        } catch {
          showToast({ type: 'info', title: 'Preview limited', message: 'Could not fetch page count.' });
        }
      }
    }
  };

  const handleAddRule = () => {
    if (!dialogSourceFile) {
      showToast({ type: 'error', title: 'Missing File', message: 'Please select a source file to insert.' });
      return;
    }
    if (dialogTargetPage < 1 || (pdfInfo && dialogTargetPage > pdfInfo.total_pages)) {
      showToast({ type: 'error', title: 'Invalid Page', message: `Target page must be between 1 and ${pdfInfo?.total_pages || 'max'}.` });
      return;
    }
    
    const isPdf = dialogSourceFile.name.toLowerCase().endsWith('.pdf');
    if (isPdf && dialogSourceMode === 'custom' && !dialogSourcePages.trim()) {
      showToast({ type: 'error', title: 'Missing Pages', message: 'Please specify pages to extract from the source PDF.' });
      return;
    }

    const newRule: InsertionRule = {
      ruleId: generateId(),
      targetPage: dialogTargetPage,
      insertMode: dialogMode,
      sourceType: isPdf ? 'pdf' : 'image',
      sourceFile: dialogSourceFile,
      previewUrl: !isPdf ? URL.createObjectURL(dialogSourceFile) : undefined,
      sourcePages: (isPdf && dialogSourceMode === 'all') ? '' : dialogSourcePages,
      originalIndex: rules.length,
      rotation: dialogRotation,
      flipH: dialogFlipH
    };
    
    setRules(prev => [...prev, newRule]);
    closeDialog();
  };

  // ── Submit ──────────────────────────────────────────────────────────────────
  const handleExecute = async () => {
    if (!file || rules.length === 0) return;
    setIsLoading(true);
    setResult(null);

    try {
      const formData = new FormData();
      formData.append('main_pdf', file);
      
      const sourceFiles: File[] = [];
      const rulesJson = rules.map((r, i) => {
        sourceFiles.push(r.sourceFile);
        return {
          rule_id: r.ruleId,
          target_page: r.targetPage,
          insert_mode: r.insertMode,
          source_type: r.sourceType,
          source_file_id: i.toString(),
          source_pages: r.sourcePages,
          original_index: r.originalIndex,
          rotation: r.rotation,
          flip_h: r.flipH
        };
      });
      
      formData.append('rules_json', JSON.stringify(rulesJson));
      sourceFiles.forEach(f => formData.append('source_files', f));
      formData.append('output_filename', outputFilename || `inserted_${file.name}`);

      const response = await apiClient.post('/api/v1/insert/', formData, { responseType: 'blob' });

      const blob = new Blob([response.data], { type: 'application/pdf' });
      const filename = getFilenameFromHeaders(response.headers, outputFilename || `inserted_${file.name}`);
      const totalPages = parseInt(response.headers['x-total-pages'] || '0', 10);
      const rulesApplied = parseInt(response.headers['x-rules-applied'] || '0', 10);

      // Auto-download immediately
      triggerBlobDownload(blob, filename);

      setResult({ filename, pages: totalPages });
      addHistoryEntry({ filename, action: 'Inserted Content', size: blob.size });
      showToast({
        type: 'success',
        title: 'Insertion Complete',
        message: `${rulesApplied} rules applied successfully`,
        action: { label: 'Open Folder', onClick: () => openOutputFolder() },
        duration: 8000,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      showToast({ type: 'error', title: 'Insertion failed', message: msg });
    } finally {
      setIsLoading(false);
    }
  };

  const removeRule = (id: string) => {
    setRules(prev => prev.filter(r => {
      if (r.ruleId === id && r.previewUrl) URL.revokeObjectURL(r.previewUrl);
      return r.ruleId !== id;
    }));
  };

  const getModeColor = (mode: string) => {
    if (mode === 'before') return 'var(--info)';
    if (mode === 'after') return 'var(--success)';
    return 'var(--warning)';
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: 36, height: 36, borderRadius: 'var(--radius-md)',
            background: 'var(--accent-dim)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', color: 'var(--accent)',
          }}>
            <FilePlus2 size={20} strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="page-title">Insert Content</h1>
            <p className="page-subtitle">Add images or PDF pages into an existing document</p>
          </div>
        </div>
      </div>

      <div className="page-body">
        <div className="feature-split-layout">
          
          {/* Controls Panel */}
          <div className="feature-controls" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>1. Main Document</h2>
            {!file ? (
              <div
                id="insert-drop-zone"
                className={`drop-zone${isDragOver ? ' drag-over' : ''}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={handleClick}
                role="button"
                tabIndex={0}
                style={{ flex: 'none', minHeight: 120 }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf"
                  style={{ display: 'none' }}
                  onChange={handleFileInput}
                />
                <Upload className="drop-zone-icon" />
                <p className="drop-zone-title">Drop main PDF here</p>
                <span className="badge badge-neutral">PDF</span>
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
                    <Filename name={result.filename} /> · {result.pages} total pages
                  </div>
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => openOutputFolder()}
                  title="Open download folder"
                >
                  <FolderOpen size={14} />
                  Open Folder
                </button>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
              <h2 style={{ fontSize: 16, fontWeight: 600 }}>2. Insertion Plan</h2>
              <button 
                className="btn btn-secondary btn-sm" 
                onClick={openDialog}
                disabled={!file}
              >
                <Plus size={14} /> Add Rule
              </button>
            </div>

            <div className="card" style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: 16, background: 'var(--surface-container-low)' }}>
              {!file ? (
                <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--on-surface-variant)', fontSize: 14 }}>
                  Select a main document first.
                </div>
              ) : rules.length === 0 ? (
                <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--on-surface-variant)', fontSize: 14 }}>
                  No rules added. Click "Add Rule" to start.
                </div>
              ) : (
                rules.map((rule, idx) => (
                  <div key={rule.ruleId} className="card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ 
                      width: 24, height: 24, borderRadius: '50%', background: 'var(--surface-container-high)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, flexShrink: 0
                    }}>
                      {idx + 1}
                    </div>
                    <div style={{ width: 40, height: 50, flexShrink: 0, borderRadius: 4, overflow: 'hidden', border: '1px solid var(--outline-variant)' }}>
                      {rule.sourceType === 'pdf' ? (
                        <PdfThumbnail file={rule.sourceFile} />
                      ) : (
                        <img 
                          src={rule.previewUrl} 
                          alt="" 
                          style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `rotate(${rule.rotation}deg) ${rule.flipH ? 'scaleX(-1)' : ''}` }} 
                        />
                      )}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, textTransform: 'uppercase',
                          background: `${getModeColor(rule.insertMode)}20`, color: getModeColor(rule.insertMode)
                        }}>
                          {rule.insertMode}
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 500 }}>Page {rule.targetPage}</span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--on-surface-variant)', display: 'flex', gap: 4 }}>
                        Source: <Filename name={rule.sourceFile.name} truncate={true} /> {rule.sourceType === 'pdf' ? `(Pages: ${rule.sourcePages || 'All'})` : ''}
                      </div>
                    </div>
                    <button className="btn btn-ghost btn-icon btn-sm" onClick={() => removeRule(rule.ruleId)}>
                      <X size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Output Filename */}
            {file && (
              <div className="card">
                <label className="input-label" htmlFor="insert-output-name">Output Filename</label>
                <input
                  id="insert-output-name"
                  className="input"
                  type="text"
                  value={outputFilename}
                  onChange={(e) => setOutputFilename(e.target.value)}
                  placeholder={`inserted_${file?.name || 'output.pdf'}`}
                />
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'auto' }}>
              <button 
                className="btn btn-primary" 
                onClick={handleExecute}
                disabled={!file || rules.length === 0 || isLoading}
              >
                {isLoading ? (
                  <><Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> Executing Plan…</>
                ) : (
                  <><CheckCircle size={15} /> Execute Plan</>
                )}
              </button>
            </div>
          </div>

          {/* Preview Panel */}
          <div className="feature-preview">
            <PreviewPanel
              pdfFile={file}
              totalPages={pdfInfo?.total_pages}
              currentPage={previewPage}
              onPageChange={setPreviewPage}
              zoom={zoom}
              onZoomChange={setZoom}
            />
          </div>
        </div>
      </div>

      {/* Rule Dialog */}
      {isDialogOpen && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 100, backdropFilter: 'blur(2px)'
        }}>
          <div className="card" style={{ width: '75vw', maxWidth: 900, maxHeight: '90vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, borderBottom: '1px solid var(--outline-variant)', paddingBottom: 12, margin: '-20px -24px 0 -24px', padding: '20px 24px 12px 24px' }}>
              Add Insertion Rule
            </h2>
            
            <div>
              <label className="input-label">Source File</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input 
                  type="file" 
                  ref={dialogFileInputRef}
                  style={{ display: 'none' }}
                  accept=".pdf,image/png,image/jpeg,image/webp"
                  onChange={handleDialogFileChange}
                />
                <button 
                  className="btn btn-secondary" 
                  onClick={() => dialogFileInputRef.current?.click()}
                  style={{ flex: 1, justifyContent: 'flex-start' }}
                >
                  <Upload size={14} /> {dialogSourceFile ? dialogSourceFile.name : 'Choose File...'}
                </button>
              </div>
              {dialogSourceFile && (
                <div style={{ marginTop: 12, height: dialogSourceFile.name.toLowerCase().endsWith('.pdf') ? 400 : 240, borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--outline-variant)', display: 'flex', flexDirection: 'column', background: 'var(--surface-container)', position: 'relative' }}>
                  {dialogSourceFile.name.toLowerCase().endsWith('.pdf') ? (
                    <PreviewPanel
                      pdfFile={dialogSourceFile}
                      totalPages={dialogSourceTotalPages}
                      currentPage={dialogSourcePage}
                      onPageChange={setDialogSourcePage}
                      zoom={dialogSourceZoom}
                      onZoomChange={setDialogSourceZoom}
                    />
                  ) : (
                    <>
                      <img 
                        src={URL.createObjectURL(dialogSourceFile)} 
                        alt="Preview" 
                        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', transform: `rotate(${dialogRotation}deg) ${dialogFlipH ? 'scaleX(-1)' : ''}`, transition: 'transform var(--transition-fast)' }} 
                        onLoad={(e) => URL.revokeObjectURL(e.currentTarget.src)} 
                      />
                      <div style={{ position: 'absolute', bottom: 12, display: 'flex', gap: 8, background: 'var(--surface)', padding: 6, borderRadius: 'var(--radius-full)', border: '1px solid var(--outline-variant)', boxShadow: 'var(--shadow-sm)' }}>
                        <button 
                          className="btn btn-ghost btn-icon btn-sm" 
                          onClick={() => setDialogRotation(r => (r - 90 + 360) % 360 as 0|90|180|270)}
                          title="Rotate Left"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                        </button>
                        <button 
                          className="btn btn-ghost btn-icon btn-sm" 
                          onClick={() => setDialogFlipH(f => !f)}
                          title="Flip Horizontal"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20v-16M8 4L4 12l4 8M16 4l4 8-4 8"/></svg>
                        </button>
                        <button 
                          className="btn btn-ghost btn-icon btn-sm" 
                          onClick={() => setDialogRotation(r => (r + 90) % 360 as 0|90|180|270)}
                          title="Rotate Right"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            <div>
              <label className="input-label">Insert Mode</label>
              <div style={{ display: 'flex', gap: 12 }}>
                {(['before', 'after', 'replace'] as const).map(mode => (
                  <label key={mode} style={{
                    flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
                    border: `1px solid ${dialogMode === mode ? 'var(--accent)' : 'var(--outline-variant)'}`,
                    background: dialogMode === mode ? 'var(--accent-dim)' : 'transparent',
                    borderRadius: 'var(--radius-md)', cursor: 'pointer', textTransform: 'capitalize'
                  }}>
                    <input 
                      type="radio" 
                      checked={dialogMode === mode} 
                      onChange={() => setDialogMode(mode)} 
                      style={{ accentColor: 'var(--accent)' }} 
                    />
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{mode}</span>
                  </label>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 16 }}>
              <div style={{ flex: 1 }}>
                <label className="input-label">Target Page (in Main PDF)</label>
                <input 
                  type="number" 
                  className="input" 
                  min={1} max={pdfInfo?.total_pages || 1}
                  value={dialogTargetPage}
                  onChange={(e) => setDialogTargetPage(parseInt(e.target.value) || 1)}
                />
              </div>
              {dialogSourceFile?.name.toLowerCase().endsWith('.pdf') && (
                <div style={{ flex: 1 }}>
                  <label className="input-label">Source Pages</label>
                  <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="radio" checked={dialogSourceMode === 'all'} onChange={() => setDialogSourceMode('all')} style={{ accentColor: 'var(--accent)' }} />
                      <span style={{ fontSize: 13 }}>All Pages</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="radio" checked={dialogSourceMode === 'custom'} onChange={() => setDialogSourceMode('custom')} style={{ accentColor: 'var(--accent)' }} />
                      <span style={{ fontSize: 13 }}>Custom Range</span>
                    </label>
                  </div>
                  {dialogSourceMode === 'custom' && (
                    <input 
                      type="text" 
                      className="input" 
                      placeholder="e.g. 1-3, 5"
                      value={dialogSourcePages}
                      onChange={(e) => setDialogSourcePages(e.target.value)}
                    />
                  )}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn btn-ghost" onClick={closeDialog}>Cancel</button>
              <button className="btn btn-primary" onClick={handleAddRule}>Add Rule</button>
            </div>
          </div>
        </div>
      )}

      
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
