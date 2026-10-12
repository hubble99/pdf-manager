import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../components/layout/Sidebar';

describe('Sidebar Component', () => {
  const renderSidebar = (initialPath = '/') => {
    return render(
      <MemoryRouter initialEntries={[initialPath]}>
        <Sidebar />
      </MemoryRouter>
    );
  };

  it('renders the consolidated converter nav item', () => {
    const { container } = renderSidebar();
    const navItems = [
      'nav-merge',
      'nav-extract',
      'nav-compress',
      'nav-converter',
      'nav-qr-barcode'
    ];
    navItems.forEach(id => {
      const element = container.querySelector(`#${id}`);
      expect(element).toBeInTheDocument();
    });
  });

  it('does not keep separate PDF and image converter entries', () => {
    const { container } = renderSidebar();
    expect(container.querySelector('#nav-pdf-to-image')).not.toBeInTheDocument();
    expect(container.querySelector('#nav-image-to-pdf')).not.toBeInTheDocument();
    expect(container.querySelector('#nav-converter')).toHaveTextContent('PDF & Image');
  });

  it('no longer offers a separate Insert Content feature', () => {
    const { container } = renderSidebar();
    expect(container.querySelector('#nav-insert')).not.toBeInTheDocument();
    expect(container.querySelector('#nav-organize')).toHaveTextContent('Organize Pages');
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
