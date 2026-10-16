import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { FileSearch, Merge } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { PageHeader, RadioCardGroup, SegmentedControl, StateView, Tabs } from '../components/ui';

describe('UI primitives', () => {
  it('renders a semantic page header with shared title and description', () => {
    render(
      <PageHeader
        icon={Merge}
        title="Merge PDF"
        description="Combine multiple files"
      />
    );

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Merge PDF' })).toBeInTheDocument();
    expect(screen.getByText('Combine multiple files')).toBeInTheDocument();
  });

  it('uses polite status semantics for neutral states', () => {
    render(
      <StateView
        icon={FileSearch}
        title="Select a file to preview"
        description="Preview appears here"
      />
    );

    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('Select a file to preview')).toBeInTheDocument();
  });

  it('uses alert semantics for errors', () => {
    render(<StateView title="Preview failed" tone="danger" />);

    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive');
  });

  it('announces loading without changing the state layout contract', () => {
    render(<StateView title="Rendering preview" loading />);

    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('moves between enabled tabs with the arrow keys and keeps one tab in the tab order', () => {
    function Harness() {
      const [value, setValue] = useState<'a' | 'b' | 'c'>('a');
      return (
        <Tabs
          ariaLabel="Modes"
          value={value}
          onChange={setValue}
          items={[
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta', disabled: true },
            { value: 'c', label: 'Gamma' },
          ]}
        />
      );
    }
    render(<Harness />);
    const alpha = screen.getByRole('tab', { name: 'Alpha' });
    const gamma = screen.getByRole('tab', { name: 'Gamma' });
    expect(alpha).toHaveAttribute('tabindex', '0');
    expect(gamma).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    expect(gamma).toHaveAttribute('aria-selected', 'true');
    expect(gamma).toHaveFocus();

    fireEvent.keyDown(gamma, { key: 'Home' });
    expect(alpha).toHaveAttribute('aria-selected', 'true');
  });

  it('reports the pressed segment and ignores clicks while disabled', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SegmentedControl
        ariaLabel="Format"
        options={[{ value: 'png', label: 'PNG' }, { value: 'jpg', label: 'JPG' }]}
        value="png"
        onChange={onChange}
      />
    );
    expect(screen.getByRole('button', { name: 'PNG' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'JPG' }));
    expect(onChange).toHaveBeenCalledWith('jpg');

    onChange.mockClear();
    rerender(
      <SegmentedControl
        ariaLabel="Format"
        disabled
        options={[{ value: 'png', label: 'PNG' }, { value: 'jpg', label: 'JPG' }]}
        value="png"
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'JPG' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('draws native radios as cards inside one named group', () => {
    const onChange = vi.fn();
    render(
      <RadioCardGroup
        ariaLabel="Page size"
        name="size"
        options={[{ value: 'a4', label: 'A4', desc: '210 × 297 mm' }, { value: 'a5', label: 'A5' }]}
        value="a4"
        onChange={onChange}
      />
    );
    expect(screen.getByRole('radiogroup', { name: 'Page size' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /A4/ })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /A5/ }));
    expect(onChange).toHaveBeenCalledWith('a5');
  });
});
