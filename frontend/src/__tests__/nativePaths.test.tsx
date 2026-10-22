import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  desktop: true,
  openFilePicker: vi.fn(),
  dragDrop: null as null | ((event: { payload: { type: string; paths?: string[] } }) => void),
}));

vi.mock('../utils/tauriDialog', () => ({
  isTauri: () => mocks.desktop,
  openFilePicker: mocks.openFilePicker,
}));

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: typeof mocks.dragDrop) => {
      mocks.dragDrop = handler;
      return () => { mocks.dragDrop = null; };
    },
  }),
}));

import { useNativePaths } from '../hooks/useNativePaths';
import { baseName, extensionOf, mergePaths, stemOf } from '../utils/paths';

const PDF = { name: 'PDF', extensions: ['pdf'] };

describe('path helpers', () => {
  it('handles Windows and POSIX paths', () => {
    expect(baseName('C:\\docs\\Report.PDF')).toBe('Report.PDF');
    expect(baseName('/home/me/a b.pdf')).toBe('a b.pdf');
    expect(extensionOf('C:\\docs\\Report.PDF')).toBe('pdf');
    expect(extensionOf('C:\\docs.d\\README')).toBe('');
    expect(stemOf('C:\\docs\\my.report.pdf')).toBe('my.report');
  });

  it('skips duplicate paths, ignoring case and slash style', () => {
    const { paths, skipped } = mergePaths(['C:\\Pics\\a.pdf'], ['c:/pics/A.pdf', 'C:\\pics\\b.pdf']);
    expect(paths).toEqual(['C:\\Pics\\a.pdf', 'C:\\pics\\b.pdf']);
    expect(skipped).toBe(1);
  });
});

describe('useNativePaths', () => {
  beforeEach(() => {
    mocks.desktop = true;
    mocks.dragDrop = null;
    mocks.openFilePicker.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  const mount = (extra: Partial<Parameters<typeof useNativePaths>[0]> = {}) => {
    const onPaths = vi.fn();
    const hook = renderHook((props: Partial<Parameters<typeof useNativePaths>[0]>) =>
      useNativePaths({ filter: PDF, pickerTitle: 'Choose', onPaths, ...props }), { initialProps: extra });
    return { onPaths, ...hook };
  };

  it('passes the picked PDF and offers both letter cases to the dialog', async () => {
    mocks.openFilePicker.mockResolvedValue(['C:\\a.pdf']);
    const { result, onPaths } = mount();
    await act(async () => { await result.current.pick(); });
    expect(mocks.openFilePicker).toHaveBeenCalledWith({
      multiple: false,
      filters: [{ name: 'PDF', extensions: ['pdf', 'PDF'] }],
      title: 'Choose',
    });
    expect(onPaths).toHaveBeenCalledWith(['C:\\a.pdf'], 0);
  });

  it('does nothing when the dialog is cancelled', async () => {
    mocks.openFilePicker.mockResolvedValue(null);
    const { result, onPaths } = mount();
    await act(async () => { await result.current.pick(); });
    expect(onPaths).not.toHaveBeenCalled();
  });

  it('looks only at the first dropped path when one file is expected', async () => {
    const { result, onPaths } = mount();
    await waitFor(() => expect(mocks.dragDrop).not.toBeNull());
    act(() => mocks.dragDrop!({ payload: { type: 'drop', paths: ['C:\\a.PDF', 'C:\\b.pdf'] } }));
    expect(onPaths).toHaveBeenCalledWith(['C:\\a.PDF'], 0);
    act(() => mocks.dragDrop!({ payload: { type: 'drop', paths: ['C:\\notes.txt', 'C:\\b.pdf'] } }));
    expect(onPaths).toHaveBeenLastCalledWith([], 1);
    expect(result.current.isDragOver).toBe(false);
  });

  it('keeps the allowed files and counts the rest when several are expected', async () => {
    const { onPaths } = mount({ multiple: true });
    await waitFor(() => expect(mocks.dragDrop).not.toBeNull());
    act(() => mocks.dragDrop!({ payload: { type: 'drop', paths: ['C:\\a.pdf', 'C:\\x.png', 'C:\\b.pdf'] } }));
    expect(onPaths).toHaveBeenCalledWith(['C:\\a.pdf', 'C:\\b.pdf'], 1);
  });

  it('follows the drag over and leave events', async () => {
    const { result } = mount();
    await waitFor(() => expect(mocks.dragDrop).not.toBeNull());
    act(() => mocks.dragDrop!({ payload: { type: 'over' } }));
    expect(result.current.isDragOver).toBe(true);
    act(() => mocks.dragDrop!({ payload: { type: 'leave' } }));
    expect(result.current.isDragOver).toBe(false);
  });

  it('ignores picks and drops while disabled, and reacts again when re-enabled', async () => {
    const { result, rerender, onPaths } = mount({ disabled: true });
    await waitFor(() => expect(mocks.dragDrop).not.toBeNull());
    act(() => mocks.dragDrop!({ payload: { type: 'drop', paths: ['C:\\a.pdf'] } }));
    await act(async () => { await result.current.pick(); });
    expect(onPaths).not.toHaveBeenCalled();
    expect(mocks.openFilePicker).not.toHaveBeenCalled();
    rerender({ disabled: false });
    act(() => mocks.dragDrop!({ payload: { type: 'drop', paths: ['C:\\a.pdf'] } }));
    expect(onPaths).toHaveBeenCalledWith(['C:\\a.pdf'], 0);
  });

  it('listens to nothing outside the desktop shell', async () => {
    mocks.desktop = false;
    const { result } = mount();
    expect(result.current.desktop).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.dragDrop).toBeNull();
  });

  it('stops listening when the page unmounts', async () => {
    const { unmount } = mount();
    await waitFor(() => expect(mocks.dragDrop).not.toBeNull());
    unmount();
    await waitFor(() => expect(mocks.dragDrop).toBeNull());
  });
});
