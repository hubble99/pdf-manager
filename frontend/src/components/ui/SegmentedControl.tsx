import type { ReactNode } from 'react';

export interface SegmentOption<T extends string | number> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
}

interface SegmentedControlProps<T extends string | number> {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  /** Options share the full width equally. */
  equal?: boolean;
  disabled?: boolean;
  idPrefix?: string;
}

/** A row of mutually exclusive buttons; the single implementation behind every `.seg`. */
export function SegmentedControl<T extends string | number>({
  options, value, onChange, ariaLabel, ariaLabelledBy, equal = false, disabled = false, idPrefix,
}: SegmentedControlProps<T>) {
  return (
    <div
      className={`seg${equal ? ' seg--equal' : ''}`}
      role="group"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            id={idPrefix ? `${idPrefix}-${option.value}` : undefined}
            className={active ? 'active' : undefined}
            aria-pressed={active}
            title={option.title}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
