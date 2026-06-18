import { useEffect, useCallback, useRef, useState } from 'react';
import {
  CheckCircle,
  Copy,
  FolderOpen,
  Grip,
  Layers,
  Loader2,
  RefreshCw,
  RotateCw,
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
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
} from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PageItem {
  id: string; // Unique ID for React key
  sourcePage: number;
  rotation: number;
}

interface PdfInfo {
  filename: string;
  total_pages: number;
  file_size_bytes: number;
}


interface OrganizeResult {
  filename: string;
  totalPages: number;
  fileSizeBytes: number;
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

// ── Sortable Item Component ───────────────────────────────────────────────────

function SortablePageItem({ 
  page, 
  index, 
  file,
  onRemove,
  onRotate,
  onDuplicate
}: { 
  page: PageItem; 
  index: number; 
  file: File | null;
  onRemove: (idx: number) => void;
  onRotate: (idx: number) => void;
  onDuplicate: (idx: number) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: page.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    background: 'var(--surface-container)',
    border: `1px solid var(--outline-variant)`,
    borderRadius: 'var(--radius-md)',
    padding: 8,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 8,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 1 : 0,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
        <div 
          className="badge" 
          style={{ 
            fontSize: 13, 
            cursor: 'grab', 
            padding: '4px 10px', 
            background: 'var(--accent)', 
            color: 'var(--on-accent)',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
          }} 
          title="Drag to reorder"
          {...listeners}
        >
           <Grip size={14} />
           {index + 1}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-ghost btn-icon" style={{ width: 28, height: 28 }} onClick={() => onRotate(index)} title="Rotate CW" onMouseDown={(e) => e.stopPropagation()}>
            <RotateCw size={16} />
          </button>
          <button className="btn btn-ghost btn-icon" style={{ width: 28, height: 28 }} onClick={() => onDuplicate(index)} title="Duplicate" onMouseDown={(e) => e.stopPropagation()}>
            <Copy size={16} />
          </button>
          <button className="btn btn-ghost btn-icon" style={{ width: 28, height: 28, color: 'var(--error)' }} onClick={() => onRemove(index)} title="Remove" onMouseDown={(e) => e.stopPropagation()}>
            <Trash2 size={16} />
          </button>
        </div>
      </div>
      
      <div style={{ pointerEvents: 'none' }}>
        {file && (
          <PdfThumbnail 
            file={file} 
            page={page.sourcePage} 
            dpi={48} 
            style={{
              width: 110,
              height: 160,
              transform: `rotate(${page.rotation}deg)`,
              transition: 'transform 0.2s ease-in-out',
              background: 'none'
            }}
          />
        )}
      </div>
      
      <div style={{ fontSize: 11, color: 'var(--on-surface-variant)', pointerEvents: 'none' }}>
        Source: Page {page.sourcePage}
      </div>
    </div>
  );
}


// ── Component ─────────────────────────────────────────────────────────────────

export function OrganizePage() {
  const { showToast } = useToast();
  const { fileData: file, setFileData: setFile } = useFeatureFile<File | null>('organize');
  const [pdfInfo, setPdfInfo] = useState<PdfInfo | null>(null);
  const [pages, setPages] = useState<PageItem[]>([]);
  const [originalPages, setOriginalPages] = useState<PageItem[]>([]);  // for Reset
  
  const [infoLoading, setInfoLoading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<OrganizeResult | null>(null);
  const [outputFilename, setOutputFilename] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );


  // ── File handling ───────────────────────────────────────────────────────────
  const loadFile = useCallback(
    async (f: File) => {
      if (!f.name.toLowerCase().endsWith('.pdf')) {
        showToast({ type: 'error', title: 'Invalid file', message: 'Only PDF files are accepted.' });
        return;
      }
      setFile(f);
      setPdfInfo(null);
      setPages([]);
      setOriginalPages([]);
      setResult(null);
      setInfoLoading(true);
      setOutputFilename(`organized_${f.name}`);

      try {
        const form = new FormData();
        form.append('file', f);
        const resp = await apiClient.post<{ status: string; data: PdfInfo }>('/api/v1/pdf-info/', form);
        const info = resp.data.data;
        setPdfInfo(info);
        
        // Initialize pages
        const initPages: PageItem[] = [];
        for (let i = 1; i <= info.total_pages; i++) {
          initPages.push({ id: generateId(), sourcePage: i, rotation: 0 });
        }
        setPages(initPages);
        setOriginalPages(initPages);  // save for Reset
        
      } catch {
        showToast({ type: 'error', title: 'PDF load failed', message: 'Could not read page count.' });
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

  // ── Page Operations ─────────────────────────────────────────────────────────

  const removePage = (index: number) => {
    setPages((prev) => {
      const newPages = [...prev];
      newPages.splice(index, 1);
      return newPages;
    });
  };

  const rotatePage = (index: number) => {
    setPages((prev) => {
      const newPages = [...prev];
      newPages[index] = { ...newPages[index], rotation: (newPages[index].rotation + 90) % 360 };
      return newPages;
    });
  };

  const duplicatePage = (index: number) => {
    setPages((prev) => {
      const newPages = [...prev];
      const pageToCopy = newPages[index];
      newPages.splice(index + 1, 0, { ...pageToCopy, id: generateId() });
      return newPages;
    });
  };

  // ── Reordering Logic ────────────────────────────────────────────────────────
  
  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;

    if (over && active.id !== over.id) {
      setPages((items) => {
        const oldIndex = items.findIndex((item) => item.id === active.id);
        const newIndex = items.findIndex((item) => item.id === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  }

  // ── Submit — single-step: process & auto-download ───────────────────────────
  const handleOrganize = async () => {
    if (!file) { showToast({ type: 'error', title: 'No file', message: 'Please select a PDF file first.' }); return; }
    if (pages.length === 0) { showToast({ type: 'error', title: 'No pages', message: 'Document must have at least one page.' }); return; }
    
    setIsLoading(true);
    setResult(null);

    const formData = new FormData();
    formData.append('file', file);
    
    const config = pages.map((p) => ({ page: p.sourcePage, rotation: p.rotation }));
    formData.append('pages_config', JSON.stringify(config));
    formData.append('output_filename', outputFilename || `organized_${file.name}`);

    try {
      const response = await apiClient.post('/api/v1/organize/', formData, { responseType: 'blob' });

      const blob = new Blob([response.data], { type: 'application/pdf' });
      const filename = getFilenameFromHeaders(response.headers, outputFilename || `organized_${file.name}`);
      const totalPages = parseInt(response.headers['x-total-pages'] || '0', 10);
      const fileSizeBytes = parseInt(response.headers['x-file-size'] || String(blob.size), 10);

      // Auto-download immediately
      triggerBlobDownload(blob, filename);

      setResult({ filename, totalPages, fileSizeBytes });
      addHistoryEntry({ filename, action: 'Organized Pages', size: fileSizeBytes });
      showToast({
        type: 'success',
        title: 'Organize complete!',
        message: `${filename} — ${totalPages} pages`,
        action: { label: 'Open Folder', onClick: () => openOutputFolder() },
        duration: 8000,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      showToast({ type: 'error', title: 'Organize failed', message: msg });
    } finally {
      setIsLoading(false);
    }
  };

  const clearFile = () => { setFile(null); setPdfInfo(null); setPages([]); setOriginalPages([]); setResult(null); setOutputFilename(''); };

  const isResetDisabled = pages.map(p=>p.id).join(',') === originalPages.map(p=>p.id).join(',');

  const activeItem = activeId ? pages.find(p => p.id === activeId) : null;

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
            <Layers size={20} strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="page-title">Organize Pages</h1>
            <p className="page-subtitle">Reorder, delete, rotate, or duplicate PDF pages</p>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="page-body">
        <div style={{ maxWidth: 840, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Drop zone */}
          {!file ? (
            <div
              id="organize-drop-zone"
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

          {/* Grid Area */}
          {file && !infoLoading && (
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  Page Order <span className="badge badge-neutral" style={{ marginLeft: 8 }}>{pages.length} Pages</span>
                </div>
                <div className="text-muted text-body-sm">
                  Drag <Grip size={12} style={{ display: 'inline', margin: '0 2px' }}/> to reorder pages
                </div>
              </div>
              
              {pages.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '32px', color: 'var(--on-surface-variant)' }}>
                  All pages removed. Document is empty.
                </div>
              ) : (
                <DndContext 
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext 
                    items={pages.map(p => p.id)}
                    strategy={rectSortingStrategy}
                  >
                    <div style={{ 
                      display: 'grid', 
                      gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', 
                      gap: 16 
                    }}>
                      {pages.map((p, idx) => (
                        <SortablePageItem
                          key={p.id}
                          page={p}
                          index={idx}
                          file={file}
                          onRemove={removePage}
                          onRotate={rotatePage}
                          onDuplicate={duplicatePage}
                        />
                      ))}
                    </div>
                  </SortableContext>

                  {/* Drag Overlay for smooth preview */}
                  <DragOverlay>
                    {activeItem ? (
                      <div style={{
                        background: 'var(--surface-container)',
                        border: `1px solid var(--accent)`,
                        borderRadius: 'var(--radius-md)',
                        padding: 8,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 8,
                        opacity: 0.9,
                        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
                        cursor: 'grabbing'
                      }}>
                         <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                            <div 
                              className="badge" 
                              style={{ 
                                fontSize: 13, 
                                padding: '4px 10px', 
                                background: 'var(--accent)', 
                                color: 'var(--on-accent)',
                                fontWeight: 600,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
                              }}
                            >
                               <Grip size={14} />
                               {pages.findIndex(p => p.id === activeItem.id) + 1}
                            </div>
                         </div>
                         <div style={{ pointerEvents: 'none' }}>
                            <PdfThumbnail 
                              file={file} 
                              page={activeItem.sourcePage} 
                              dpi={48} 
                              style={{
                                width: 110,
                                height: 160,
                                transform: `rotate(${activeItem.rotation}deg)`,
                                background: 'none'
                              }}
                            />
                         </div>
                      </div>
                    ) : null}
                  </DragOverlay>
                </DndContext>
              )}
            </div>
          )}

          {/* Output Filename */}
          {file && !infoLoading && (
            <div className="card">
              <label className="input-label" htmlFor="organize-output-name">Output Filename</label>
              <input
                id="organize-output-name"
                className="input"
                type="text"
                value={outputFilename}
                onChange={(e) => setOutputFilename(e.target.value)}
                placeholder={`organized_${file?.name || 'output.pdf'}`}
              />
            </div>
          )}

          {/* Result — download was triggered automatically */}
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
                  <Filename name={result.filename} /> · {result.totalPages} pages · {formatBytes(result.fileSizeBytes)}
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

          {/* Actions */}
          {file && (
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button
                className="btn btn-secondary"
                onClick={clearFile}
                disabled={isLoading}
              >
                Clear
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => { setPages([...originalPages]); setResult(null); }}
                disabled={isLoading || isResetDisabled}
                title="Restore original page order"
              >
                <RefreshCw size={15} />
                Reset
              </button>
              <button
                className="btn btn-primary"
                onClick={handleOrganize}
                disabled={isLoading || pages.length === 0}
              >
                {isLoading ? (
                  <>
                    <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
                    Processing…
                  </>
                ) : (
                  <>
                    <CheckCircle size={15} />
                    Apply & Download
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
