import { useEffect, useMemo } from 'react';

interface ConverterThumbnailProps {
  file: File;
  rotation: number;
  flipH: boolean;
  alt?: string;
}

/**
 * Owns the object URL of one image preview. Source files are retained in the
 * feature store, so a preview URL is recreated from the file on each mount and
 * released when this preview no longer owns it.
 */
export function ConverterThumbnail({ file, rotation, flipH, alt = '' }: ConverterThumbnailProps) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);

  useEffect(() => {
    return () => URL.revokeObjectURL(url);
  }, [url]);

  return (
    <img
      src={url}
      alt={alt}
      draggable={false}
      style={{ transform: `rotate(${rotation}deg) ${flipH ? 'scaleX(-1)' : ''}` }}
    />
  );
}
