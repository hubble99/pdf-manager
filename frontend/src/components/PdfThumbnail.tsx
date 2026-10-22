import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { FileText, Loader2 } from 'lucide-react';
import { fetchPagePreview, isAbort, type PdfSource } from '../api/pdfRender';

interface PdfThumbnailProps {
  file: PdfSource;
  page?: number;
  dpi?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function PdfThumbnail({ file, page = 1, dpi = 72, className = '', style }: PdfThumbnailProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const abortController = new AbortController();
    let currentUrl: string | null = null;
    
    async function load() {
      setLoading(true);
      try {
        const blob = await fetchPagePreview(file, { page, dpi, quality: 'low', signal: abortController.signal });
        currentUrl = URL.createObjectURL(blob);
        setUrl(currentUrl);
      } catch (err: unknown) {
        if (isAbort(err)) return;
        console.error('Failed to load PDF preview', err);
      } finally {
        if (!abortController.signal.aborted) {
          setLoading(false);
        }
      }
    }
    
    load();
    
    return () => {
      abortController.abort();
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [file, page, dpi]);

  return (
    <div 
      className={`file-item-icon ${className}`} 
      style={{ 
        padding: url ? 0 : undefined, 
        overflow: 'hidden',
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        ...style
      }}
    >
      {loading ? (
        <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
      ) : url ? (
        <img src={url} alt={t('Page {n}', { n: page })} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      ) : (
        <FileText size={18} />
      )}
    </div>
  );
}
