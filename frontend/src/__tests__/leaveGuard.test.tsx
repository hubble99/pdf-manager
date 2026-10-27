import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Link, Route, Routes } from 'react-router-dom';
import { LeaveGuardProvider } from '../context/LeaveGuard';
import { useLeaveGuard } from '../hooks/useLeaveGuard';

function Page({ holdsFile }: { holdsFile: boolean }) {
  useLeaveGuard(holdsFile);
  return <Link to="/other">Go elsewhere</Link>;
}

function renderApp(holdsFile: boolean) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <LeaveGuardProvider>
        <Routes>
          <Route path="/" element={<Page holdsFile={holdsFile} />} />
          <Route path="/other" element={<p>Other page</p>} />
        </Routes>
      </LeaveGuardProvider>
    </MemoryRouter>,
  );
}

describe('leave guard', () => {
  it('lets the user go straight away when nothing is loaded', () => {
    renderApp(false);
    fireEvent.click(screen.getByText('Go elsewhere'));
    expect(screen.getByText('Other page')).toBeInTheDocument();
  });

  it('warns that the file is removed and stays when the user chooses Stay', () => {
    renderApp(true);
    fireEvent.click(screen.getByText('Go elsewhere'));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('The file you loaded here will be removed');
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByText('Go elsewhere')).toBeInTheDocument();
  });

  it('goes to the other page after Leave', () => {
    renderApp(true);
    fireEvent.click(screen.getByText('Go elsewhere'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(screen.getByText('Other page')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
