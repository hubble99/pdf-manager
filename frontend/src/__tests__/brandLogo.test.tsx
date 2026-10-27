import { render, screen } from '@testing-library/react';
import { BrandLogo } from '../components/BrandLogo';
import { APP_NAME } from '../config/app';

describe('BrandLogo', () => {
  it('inlines the full mascot with the app name as its accessible label', () => {
    const { container } = render(<BrandLogo size={120} />);
    const logo = screen.getByRole('img', { name: APP_NAME });
    expect(logo).toHaveStyle({ width: '120px', height: '120px' });
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(container.querySelector('.brand-logo--animated')).not.toBeInTheDocument();
  });

  it('exposes the waving arm and animates only when asked', () => {
    const { container } = render(<BrandLogo size={160} animated />);
    expect(container.querySelector('.brand-logo--animated')).toBeInTheDocument();
    expect(container.querySelector('.brand-logo--animated .dk-wave')).toBeInTheDocument();
  });

  it('renders the simplified mark as a decorative image', () => {
    const { container } = render(<BrandLogo variant="mark" size={32} />);
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('width', '32');
    expect(container.querySelector('svg')).not.toBeInTheDocument();
  });
});
