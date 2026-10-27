import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LeaveGuardContext } from './LeaveGuard.context';
import { t } from '../i18n';

/**
 * No file is shared between features, and a feature forgets its file when the
 * user leaves it. This provider makes that visible: while a page holds a loaded
 * file (see `useLeaveGuard`), a click on a link to another page opens a dialog
 * that says the file will be removed, and the page changes only after "Leave".
 */
export const LeaveGuardProvider = ({ children }: { children: ReactNode }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const holders = useRef(new Set<string>());
  const [guarded, setGuarded] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const stayRef = useRef<HTMLButtonElement>(null);

  const setHoldsFile = useCallback((id: string, holds: boolean) => {
    if (holds) holders.current.add(id);
    else holders.current.delete(id);
    setGuarded(holders.current.size > 0);
  }, []);
  const value = useMemo(() => ({ setHoldsFile }), [setHoldsFile]);

  useEffect(() => {
    if (!guarded) return undefined;
    const handleLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest('a[href]') as HTMLAnchorElement | null;
      if (!link || link.target || link.origin !== window.location.origin || link.pathname === window.location.pathname) return;
      event.preventDefault();
      event.stopPropagation();
      setPendingPath(`${link.pathname}${link.search}${link.hash}`);
    };
    document.addEventListener('click', handleLink, true);
    return () => document.removeEventListener('click', handleLink, true);
  }, [guarded]);

  // A page change by any other route (back button, a redirect) drops the question.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingPath(null);
  }, [location.pathname]);

  useEffect(() => {
    if (pendingPath) stayRef.current?.focus();
  }, [pendingPath]);

  const leave = () => {
    const path = pendingPath;
    setPendingPath(null);
    if (path) navigate(path);
  };

  return (
    <LeaveGuardContext.Provider value={value}>
      {children}
      {pendingPath && (
        <div
          className="leave-guard-backdrop"
          onKeyDown={(event) => { if (event.key === 'Escape') setPendingPath(null); }}
        >
          <div className="leave-guard-dialog" role="alertdialog" aria-modal="true" aria-labelledby="leave-guard-title" aria-describedby="leave-guard-text">
            <h2 id="leave-guard-title">{t('Leave this feature?')}</h2>
            <p id="leave-guard-text">{t('The file you loaded here will be removed. You will need to add it again if you come back.')}</p>
            <div className="leave-guard-actions">
              <button ref={stayRef} type="button" className="btn btn-primary" onClick={() => setPendingPath(null)}>{t('Stay')}</button>
              <button type="button" className="btn btn-secondary" id="leave-guard-leave" onClick={leave}>{t('Leave')}</button>
            </div>
          </div>
        </div>
      )}
    </LeaveGuardContext.Provider>
  );
};
