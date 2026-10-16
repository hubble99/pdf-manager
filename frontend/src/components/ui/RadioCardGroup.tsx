import { useId } from 'react';

export interface RadioCardOption<T extends string> {
  value: T;
  label: string;
  desc?: string;
  /** Spans the full row of the grid. */
  wide?: boolean;
}

interface RadioCardGroupProps<T extends string> {
  options: readonly RadioCardOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Visible group label, referenced by id. */
  labelledBy?: string;
  ariaLabel?: string;
  /** Native radio group name; generated when omitted. */
  name?: string;
  disabled?: boolean;
  /** Prefix for each radio's DOM id (`<prefix>-<value>`). */
  idPrefix?: string;
}

/** Native radios drawn as cards, so arrow keys and form semantics come from the browser. */
export function RadioCardGroup<T extends string>({
  options, value, onChange, labelledBy, ariaLabel, name, disabled = false, idPrefix,
}: RadioCardGroupProps<T>) {
  const generated = useId();
  const group = name ?? generated;
  return (
    <div className="opt-grid" role="radiogroup" aria-labelledby={labelledBy} aria-label={ariaLabel}>
      {options.map((option) => {
        const selected = option.value === value;
        const id = idPrefix ? `${idPrefix}-${option.value}` : undefined;
        return (
          <label
            key={option.value}
            htmlFor={id}
            className={`radio-card${selected ? ' active' : ''}${option.wide ? ' radio-card--wide' : ''}`}
          >
            <input
              id={id}
              type="radio"
              name={group}
              value={option.value}
              checked={selected}
              disabled={disabled}
              onChange={() => onChange(option.value)}
            />
            <span className="radio-copy">
              <span className="radio-title">{option.label}</span>
              {option.desc && <span className="radio-desc">{option.desc}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}
