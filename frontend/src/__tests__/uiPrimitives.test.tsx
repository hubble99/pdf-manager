import { render, screen } from '@testing-library/react';
import { FileSearch, Merge } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { PageHeader, StateView } from '../components/ui';

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
});
