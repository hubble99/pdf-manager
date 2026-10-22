import { useEffect, useState } from 'react';
import { imageThumbnail } from '../../api/pdfImage';

interface ConverterThumbnailProps {
  path: string;
  rotation: number;
  flipH: boolean;
  alt?: string;
}

/**
 * Shows one picture's preview. The native core decodes it (any format the
 * converter accepts, oriented like the PDF page); this component owns the
 * object URL and releases it when the preview goes away.
 */
export function ConverterThumbnail({ path, rotation, flipH, alt = '' }: ConverterThumbnailProps) {
  // The state belongs to one path; a different path starts blank without an effect-time reset.
  const [loaded, setLoaded] = useState<{ path: string; url: string | null }>({ path: '', url: null });

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    imageThumbnail(path)
      .then((blob) => {
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setLoaded({ path, url: created });
      })
      .catch(() => { if (!cancelled) setLoaded({ path, url: null }); });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [path]);

  const ready = loaded.path === path;
  const url = ready ? loaded.url : null;
  const failed = ready && loaded.url === null;
  const turned = rotation % 180 !== 0;

  return (
    <span className={`conv-thumb${turned ? ' conv-thumb--turned' : ''}`}>
      {url ? (
        <img
          src={url}
          alt={alt}
          draggable={false}
          style={{ transform: `rotate(${rotation}deg) ${flipH ? 'scaleX(-1)' : ''}` }}
        />
      ) : (
        <span className="conv-thumb-empty" aria-hidden={!failed}>{failed ? '!' : ''}</span>
      )}
    </span>
  );
}
