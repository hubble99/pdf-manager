import { useContext } from 'react';
import { FileContext } from '../context/FileContext.context';
import type { FeatureFileData } from '../context/FileContext.context';

export const useFeatureFile = <T extends FeatureFileData>(featureId: string) => {
  const ctx = useContext(FileContext);
  if (!ctx) throw new Error('useFeatureFile must be used within FileProvider');

  return {
    fileData: (ctx.featureFiles[featureId] || null) as T,
    setFileData: (action: T | ((prev: T) => T)) => {
      const contextAction = typeof action === 'function'
        ? (prev: FeatureFileData) => action(prev as T)
        : action;
      ctx.setFeatureFile(featureId, contextAction);
    },
    clearFileData: () => ctx.clearFeatureFile(featureId),
  };
};
