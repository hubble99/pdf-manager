import { useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { FileContext } from './FileContext.context';
import type { FeatureFileData } from './FileContext.context';

const MAX_MEMORY_BYTES = 100 * 1024 * 1024; // 100MB

function calculateSize(data: FeatureFileData): number {
  if (!data) return 0;
  if (data instanceof File) return data.size;
  if (Array.isArray(data)) {
    return data.reduce((sum, item) => {
      if (item instanceof File) return sum + item.size;
      if (item && 'file' in item && item.file instanceof File) return sum + item.file.size;
      return sum;
    }, 0);
  }
  return 0;
}

export const FileProvider = ({ children }: { children: ReactNode }) => {
  const [featureFiles, setFeatureFiles] = useState<Record<string, FeatureFileData>>({});

  const setFeatureFile = useCallback((featureId: string, action: FeatureFileData | ((prev: FeatureFileData) => FeatureFileData)) => {
    setFeatureFiles((prevContext) => {
      const prevData = prevContext[featureId] || null;
      // Handle functional updates (prev => next)
      const nextData = typeof action === 'function' ? action(prevData) : action;
      
      const size = calculateSize(nextData);
      
      // Eviction logic: if this new data alone is > 100MB, clear ALL other features
      if (size > MAX_MEMORY_BYTES) {
        return { [featureId]: nextData };
      } else {
        return { ...prevContext, [featureId]: nextData };
      }
    });
  }, []);

  const clearFeatureFile = useCallback((featureId: string) => {
    setFeatureFiles((prev) => {
      const next = { ...prev };
      delete next[featureId];
      return next;
    });
  }, []);

  return (
    <FileContext.Provider value={{ featureFiles, setFeatureFile, clearFeatureFile }}>
      {children}
    </FileContext.Provider>
  );
};
