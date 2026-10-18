import { useRef } from 'react';
import { Trash2 } from 'lucide-react';
import { t } from '../../i18n';

export interface ChangeFileControlsProps {
  /** Value for the file input's accept attribute, e.g. ".pdf". */
  accept: string;
  /** Called with the file the user picked. */
  onPick: (file: File) => void;
  /** Called when the user removes the current file without choosing another. */
  onClear: () => void;
  disabled?: boolean;
  /** Prefix for element ids, e.g. "compress" gives "compress-change-file". */
  idPrefix: string;
}

/**
 * The two ways to leave the current file on a single-file tool: "Change file"
 * opens the file picker straight away, and the red bin removes the file.
 * Changing a file never goes through an empty state first.
 */
export function ChangeFileControls({ accept, onPick, onClear, disabled = false, idPrefix }: ChangeFileControlsProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        id={`${idPrefix}-change-input`}
        type="file"
        accept={accept}
        tabIndex={-1}
        aria-hidden="true"
        style={{ display: 'none' }}
        onChange={(event) => {
          const picked = event.target.files?.[0];
          event.target.value = '';
          if (picked) onPick(picked);
        }}
      />
      <button
        type="button"
        className="link-btn"
        id={`${idPrefix}-change-file`}
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
      >
        {t('Change file')}
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm converter-danger"
        id={`${idPrefix}-remove-file`}
        onClick={onClear}
        disabled={disabled}
        aria-label={t('Remove file')}
        title={t('Remove file')}
      >
        <Trash2 size={14} aria-hidden="true" />
      </button>
    </>
  );
}
