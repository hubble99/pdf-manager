import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../components/layout/Sidebar';
import { describe, it, expect } from 'vitest';

describe('Sidebar Component', () => {
  const renderSidebar = (initialPath = '/') => {
    return render(
      <MemoryRouter initialEntries={[initialPath]}>
        <Sidebar />
      </MemoryRouter>
    );
  };

  it('renders all 7 nav items', () => {
    const { container } = renderSidebar();
    const navItems = [
      'nav-merge',
      'nav-extract',
      'nav-compress',
      'nav-pdf-to-image',
      'nav-image-to-pdf',
      'nav-qr-barcode',
      'nav-insert'
    ];
    navItems.forEach(id => {
      const element = container.querySelector(`#${id}`);
      expect(element).toBeInTheDocument();
    });
  });

  it('renders Settings item', () => {
    const { container } = renderSidebar();
    const settingsItem = container.querySelector('#nav-settings');
    expect(settingsItem).toBeInTheDocument();
  });

  it('applies active link styling when route matches', () => {
    // Route matches '/merge'
    const { container } = renderSidebar('/merge');
    const mergeItem = container.querySelector('#nav-merge');
    const extractItem = container.querySelector('#nav-extract');

    expect(mergeItem).toHaveClass('active');
    expect(extractItem).not.toHaveClass('active');
  });
});
