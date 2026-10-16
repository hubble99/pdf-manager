import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  /** DOM id of the tab button. */
  id?: string;
  /** Id of the panel this tab controls. */
  controls?: string;
  disabled?: boolean;
  title?: string;
}

interface TabsProps<T extends string> {
  ariaLabel: string;
  items: readonly TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Extra content shown after the tabs, such as a short note. */
  children?: ReactNode;
}

/**
 * The shared mode switcher. Keeps one tab in the tab order and moves between the
 * enabled tabs with the arrow keys, Home, and End.
 */
export function Tabs<T extends string>({ ariaLabel, items, value, onChange, children }: TabsProps<T>) {
  const refs = useRef(new Map<T, HTMLButtonElement>());

  const move = (event: KeyboardEvent<HTMLButtonElement>, from: number) => {
    const enabled = items.filter((item) => !item.disabled);
    if (enabled.length < 2) return;
    const current = enabled.findIndex((item) => item.value === items[from].value);
    let next: number;
    if (event.key === 'ArrowRight') next = (current + 1) % enabled.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + enabled.length) % enabled.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = enabled.length - 1;
    else return;
    event.preventDefault();
    const target = enabled[next];
    onChange(target.value);
    refs.current.get(target.value)?.focus();
  };

  return (
    <div className="tabs" role="tablist" aria-label={ariaLabel}>
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            ref={(node) => {
              if (node) refs.current.set(item.value, node);
              else refs.current.delete(item.value);
            }}
            type="button"
            role="tab"
            id={item.id}
            aria-selected={selected}
            aria-controls={item.controls}
            tabIndex={selected ? 0 : -1}
            className={`tab${selected ? ' active' : ''}`}
            disabled={item.disabled}
            title={item.title}
            onClick={() => onChange(item.value)}
            onKeyDown={(event) => move(event, index)}
          >
            {item.icon}
            {item.icon ? ' ' : null}
            {item.label}
          </button>
        );
      })}
      {children}
    </div>
  );
}
