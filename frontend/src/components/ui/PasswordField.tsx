import { t } from '../../i18n';
import { useId, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

interface PasswordFieldProps {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Message shown under the field and linked to it for assistive tech. */
  error?: string;
  autoComplete?: string;
}

/** A masked field with a show/hide toggle; the single password input used across tools. */
export function PasswordField({
  id,
  label,
  value,
  onChange,
  placeholder,
  error,
  autoComplete = 'new-password',
}: PasswordFieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const errorId = `${inputId}-error`;
  const [visible, setVisible] = useState(false);

  return (
    <div className="password-field">
      <label className="input-label" htmlFor={inputId}>{label}</label>
      <div className="password-field-control">
        <input
          id={inputId}
          className="input password-field-input"
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        <button
          type="button"
          className="password-field-toggle"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? t('Hide {label}', { label }) : t('Show {label}', { label })}
          aria-pressed={visible}
        >
          {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
        </button>
      </div>
      {error && <p className="password-field-error" id={errorId} role="status">{error}</p>}
    </div>
  );
}
