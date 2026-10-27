import { render, screen } from '@testing-library/react';
import { BrandLogo } from '../components/BrandLogo';
import { themedLogoSvg } from '../components/brandColors';
import { ThemeContext } from '../context/ThemeContext.context';
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

  it('recolours the logo in the Dusty Rose theme and leaves it blue elsewhere', () => {
    const source = '<svg><stop stop-color="#1f5cc0"/><stop stop-color="#ffffff"/></svg>';
    const rose = themedLogoSvg(source, 'dusty-rose');
    expect(rose).not.toContain('#1f5cc0');
    expect(rose).toContain('#ffffff');
    expect(themedLogoSvg(source, 'light')).toContain('#1f5cc0');
  });

  it('inlines the mark in Dusty Rose so it can be recoloured', () => {
    const { container } = render(
      <ThemeContext.Provider value={{ theme: 'dusty-rose', setTheme: () => undefined }}>
        <BrandLogo variant="mark" size={32} />
      </ThemeContext.Provider>,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
  });
});
