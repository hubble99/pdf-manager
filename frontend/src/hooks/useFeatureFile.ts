import { useContext } from 'react';
import { FileContext } from '../context/FileContext';
import type { FeatureFileData } from '../context/FileContext';

export const useFeatureFile = <T extends FeatureFileData>(featureId: string) => {
  const ctx = useContext(FileContext);
  if (!ctx) throw new Error('useFeatureFile must be used within FileProvider');

  return {
    fileData: (ctx.featureFiles[featureId] || null) as T,
    setFileData: (action: T | ((prev: T) => T)) => ctx.setFeatureFile(featureId, action),
    clearFileData: () => ctx.clearFeatureFile(featureId),
  };
};
