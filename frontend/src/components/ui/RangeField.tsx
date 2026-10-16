import type { ReactNode } from 'react';

interface RangeFieldProps {
  id: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  /** Spoken value, for example "Balanced, 55". */
  valueText?: string;
  /** Scale captions shown under the track. */
  scale?: ReactNode;
}

/** The shared slider: one `.range` track with an optional caption row. */
export function RangeField({ id, min, max, step = 1, value, onChange, disabled, valueText, scale }: RangeFieldProps) {
  return (
    <>
      <input
        id={id}
        className="range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={valueText}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {scale && <div className="range-scale">{scale}</div>}
    </>
  );
}
