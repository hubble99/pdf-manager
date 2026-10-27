import { useContext, useMemo } from 'react';
import logoSvg from '../assets/brand/dokuwu-logo.svg?raw';
import markSvg from '../assets/brand/dokuwu-mark.svg?raw';
import markUrl from '../assets/brand/dokuwu-mark.svg';
import { APP_NAME } from '../config/app';
import { ThemeContext, isTheme, type Theme } from '../context/ThemeContext.context';
import { themedLogoSvg } from './brandColors';

interface BrandLogoProps {
  /** Rendered width and height in pixels. */
  size: number;
  /**
   * `mark` is the simplified document for small slots; `full` is the whole
   * mascot. Only `full` can animate, because it is inlined so CSS can reach its parts.
   */
  variant?: 'mark' | 'full';
  /** Pop-in, a gentle float and one wave. Transform-only, so it stays cheap. */
  animated?: boolean;
  className?: string;
}

/** The Dokuwu logo. Decorative by default: the app name is always written next to it. */
export function BrandLogo({ size, variant = 'full', animated = false, className }: BrandLogoProps) {
  const style = { width: size, height: size };
  const theme = useLogoTheme();
  // Only a recoloured theme needs the artwork inlined; otherwise the mark stays a cheap image.
  const recolored = theme === 'dusty-rose';
  const svg = useMemo(
    () => themedLogoSvg(variant === 'mark' ? markSvg : logoSvg, theme),
    [variant, theme],
  );

  if (variant === 'mark' && !recolored) {
    return <img className={className} src={markUrl} alt="" width={size} height={size} style={style} draggable={false} />;
  }

  if (variant === 'mark') {
    // logoSvg and markSvg are our own bundled files, never user input.
    return (
      <span
        className={['brand-logo', className ?? ''].filter(Boolean).join(' ')}
        style={style}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }

  const classes = ['brand-logo', animated ? 'brand-logo--animated' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  // The SVG is our own bundled file, never user input.
  return (
    <span
      className={classes}
      style={style}
      role="img"
      aria-label={APP_NAME}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * The theme the logo is drawn for. The splash screen renders before the theme provider
 * exists, so it falls back to the saved choice.
 */
function useLogoTheme(): Theme {
  const context = useContext(ThemeContext);
  if (context) return context.theme;
  try {
    const saved = localStorage.getItem('app_theme');
    if (isTheme(saved)) return saved;
  } catch {
    // Storage can be blocked; the default look is fine.
  }
  return 'light';
}
