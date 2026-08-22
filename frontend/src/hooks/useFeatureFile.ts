import { useCallback, useContext } from 'react';
import { FileContext } from '../context/FileContext.context';
import type { FeatureFileData } from '../context/FileContext.context';

export const useFeatureFile = <T extends FeatureFileData>(featureId: string) => {
  const ctx = useContext(FileContext);
  if (!ctx) throw new Error('useFeatureFile must be used within FileProvider');

  const { featureFiles, setFeatureFile, clearFeatureFile } = ctx;

  const setFileData = useCallback((action: T | ((prev: T) => T)) => {
    const contextAction = typeof action === 'function'
      ? (prev: FeatureFileData) => action(prev as T)
      : action;
    setFeatureFile(featureId, contextAction);
  }, [featureId, setFeatureFile]);

  const clearFileData = useCallback(() => {
    clearFeatureFile(featureId);
  }, [clearFeatureFile, featureId]);

  return {
    fileData: (featureFiles[featureId] || null) as T,
    setFileData,
    clearFileData,
  };
};
