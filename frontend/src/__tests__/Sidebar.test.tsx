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

  it('is driven by the feature registry, Home first and Donation above Settings', () => {
    const { container } = renderSidebar();
    const ids = [...container.querySelectorAll('[id^="nav-"]')].map((node) => node.id);
    expect(ids[0]).toBe('nav-home');
    expect(ids).toContain('nav-donation');
    expect(ids.indexOf('nav-donation')).toBeLessThan(ids.indexOf('nav-settings'));

    // Group headings come from the registry and appear on the surface. The
    // footer entries (Donation, Settings) are not features, so they carry no
    // heading of their own.
    const labels = [...container.querySelectorAll('.sidebar-section-label')].map((n) => n.textContent);
    expect(labels).toEqual(['Organize', 'Convert', 'Edit', 'Optimize', 'Protect', 'Create']);
    expect(container.querySelector('.sidebar-foot #nav-donation')).toBeInTheDocument();
    expect(container.querySelector('.sidebar-foot #nav-settings')).toBeInTheDocument();
  });

  it('shows the grouped feature names from the registry', () => {
    const { container } = renderSidebar();
    expect(container.querySelector('#nav-organize')).toHaveTextContent('Organize PDF');
    expect(container.querySelector('#nav-converter')).toHaveTextContent('PDF & Image');
    expect(container.querySelector('#nav-merge')).toHaveTextContent('Merge PDF');
  });

  it('no longer offers a separate Insert Content feature', () => {
    const { container } = renderSidebar();
    expect(container.querySelector('#nav-insert')).not.toBeInTheDocument();
    expect(container.querySelector('#nav-organize')).toHaveTextContent('Organize PDF');
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

  it('marks Edit Content as Beta on the navigation item', () => {
    const { container } = renderSidebar();
    const item = container.querySelector('#nav-edit-content');
    expect(item).toBeInTheDocument();
    const badge = container.querySelector('#nav-beta-edit-content');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('BETA');
    expect(badge).toHaveAttribute('title', 'Beta: this feature is still unstable.');
  });

  it('marks PDF to Word as Beta and says why', () => {
    const { container } = renderSidebar();
    const badge = container.querySelector('#nav-beta-pdf-to-word');
    expect(badge).toHaveTextContent('BETA');
    expect(badge).toHaveAttribute('title', expect.stringContaining('pictures or a letterhead'));
  });

  it('renames Edit Canvas to Canvas PDF in the sidebar', () => {
    const { container } = renderSidebar();
    expect(container.querySelector('#nav-edit-canvas')).toHaveTextContent('Canvas PDF');
    expect(container.querySelector('#nav-edit-canvas')).not.toHaveTextContent('Edit Canvas');
  });
});
