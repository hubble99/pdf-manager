import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ThumbnailStrip } from '../components/preview/ThumbnailStrip';

vi.mock('../components/PdfThumbnail', () => ({
  PdfThumbnail: ({ page = 1 }: { page?: number }) => <span data-testid={`thumb-${page}`} />,
}));

const file = new File(['pdf'], 'document.pdf', { type: 'application/pdf' });

function setup(overrides: Partial<Parameters<typeof ThumbnailStrip>[0]> = {}) {
  const onPageClick = vi.fn();
  const onTogglePage = vi.fn();
  render(
    <ThumbnailStrip
      file={file}
      totalPages={3}
      currentPage={1}
      selectedPages={new Set([1, 3])}
      onPageClick={onPageClick}
      onTogglePage={onTogglePage}
      {...overrides}
    />,
  );
  return { onPageClick, onTogglePage };
}

describe('ThumbnailStrip selection semantics', () => {
  it('keeps preview navigation and membership controls separate', () => {
    const { onPageClick, onTogglePage } = setup();

    fireEvent.click(screen.getByRole('button', { name: 'Preview page 2' }));
    expect(onPageClick).toHaveBeenCalledWith(2);
    expect(onTogglePage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Include page 2 in the export' }));
    expect(onTogglePage).toHaveBeenCalledWith(2);
    expect(onPageClick).toHaveBeenCalledTimes(1);
  });

  it('marks the active page for assistive technology', () => {
    setup({ currentPage: 2 });
    expect(screen.getByRole('button', { name: 'Preview page 2' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Preview page 1' })).not.toHaveAttribute('aria-current');
  });

  it('keeps membership checkboxes enabled by default for existing callers', () => {
    const { onTogglePage } = setup();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    boxes.forEach((box) => expect(box).toBeEnabled());
    expect(screen.getByRole('checkbox', { name: 'Include page 1 in the export' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Include page 2 in the export' })).not.toBeChecked();
    expect(onTogglePage).not.toHaveBeenCalled();
  });

  it('disables membership editing without disabling preview navigation', () => {
    const { onPageClick, onTogglePage } = setup({ selectionDisabled: true });

    const boxes = screen.getAllByRole('checkbox');
    boxes.forEach((box) => expect(box).toBeDisabled());
    fireEvent.click(boxes[1]);
    expect(onTogglePage).not.toHaveBeenCalled();

    const nav = screen.getByRole('button', { name: 'Preview page 3' });
    expect(nav).toBeEnabled();
    fireEvent.click(nav);
    expect(onPageClick).toHaveBeenCalledWith(3);
  });
});
