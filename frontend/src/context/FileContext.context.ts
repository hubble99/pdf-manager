import { createContext } from 'react';

/** What a feature keeps while the user is on another page: browser files, or paths for native features. */
export type FeatureFileData = File | string | File[] | Array<{ file: File }> | Array<{ path: string }> | null;

export interface FileContextValue {
  featureFiles: Record<string, FeatureFileData>;
  setFeatureFile: (
    featureId: string,
    action: FeatureFileData | ((prev: FeatureFileData) => FeatureFileData),
  ) => void;
  clearFeatureFile: (featureId: string) => void;
}

export const FileContext = createContext<FileContextValue | null>(null);