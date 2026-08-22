import { act, fireEvent, render } from '@testing-library/react';
import { vi } from 'vitest';
import { ToastContainer } from '../components/ToastContainer';
import { ToastContext } from '../context/ToastContext.context';

describe('ToastContainer action feedback', () => {
  it('shows opening and opened states for an asynchronous folder action', async () => {
    let resolveOpen: (value: boolean) => void = () => undefined;
    const openFolder = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveOpen = resolve;
    }));

    const { getByRole } = render(
      <ToastContext.Provider value={{
        toasts: [{
          id: 'folder-toast',
          type: 'success',
          title: 'PDF saved',
          action: { label: 'Open Folder', onClick: openFolder },
        }],
        showToast: vi.fn(),
        dismissToast: vi.fn(),
      }}>
        <ToastContainer />
      </ToastContext.Provider>,
    );

    fireEvent.click(getByRole('button', { name: 'Open Folder' }));
    expect(getByRole('button', { name: 'Opening folder…' })).toBeDisabled();

    await act(async () => {
      resolveOpen(true);
    });
    expect(getByRole('button', { name: 'Folder opened' })).toBeDisabled();
  });
});
