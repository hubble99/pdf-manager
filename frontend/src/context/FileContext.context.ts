import { createContext } from 'react';

export type FeatureFileData = File | File[] | Array<{ file: File }> | null;

export interface FileContextValue {
  featureFiles: Record<string, FeatureFileData>;
  setFeatureFile: (
    featureId: string,
    action: FeatureFileData | ((prev: FeatureFileData) => FeatureFileData),
  ) => void;
  clearFeatureFile: (featureId: string) => void;
}

export const FileContext = createContext<FileContextValue | null>(null);