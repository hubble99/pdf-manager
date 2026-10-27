import { createContext } from 'react';

export interface LeaveGuardValue {
  /** Marks `id` as holding a loaded file (or not). While any id does, leaving the page asks first. */
  setHoldsFile: (id: string, holds: boolean) => void;
}

export const LeaveGuardContext = createContext<LeaveGuardValue | null>(null);
