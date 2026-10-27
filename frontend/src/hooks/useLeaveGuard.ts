import { useContext, useEffect, useId } from 'react';
import { LeaveGuardContext } from '../context/LeaveGuard.context';

/**
 * Call with `true` while the page holds a loaded file. Leaving the page for
 * another one then shows a warning that the file is removed and must be added
 * again, and goes on only when the user agrees.
 */
export const useLeaveGuard = (holdsFile: boolean): void => {
  const ctx = useContext(LeaveGuardContext);
  const id = useId();
  const setHoldsFile = ctx?.setHoldsFile;
  useEffect(() => {
    if (!setHoldsFile) return undefined;
    setHoldsFile(id, holdsFile);
    return () => setHoldsFile(id, false);
  }, [holdsFile, id, setHoldsFile]);
};
