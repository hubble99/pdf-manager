import logoSvg from '../assets/brand/dokuwu-logo.svg?raw';
import markUrl from '../assets/brand/dokuwu-mark.svg';
import { APP_NAME } from '../config/app';

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

  if (variant === 'mark') {
    return <img className={className} src={markUrl} alt="" width={size} height={size} style={style} draggable={false} />;
  }

  const classes = ['brand-logo', animated ? 'brand-logo--animated' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  // logoSvg is our own bundled file, never user input.
  return (
    <span
      className={classes}
      style={style}
      role="img"
      aria-label={APP_NAME}
      dangerouslySetInnerHTML={{ __html: logoSvg }}
    />
  );
}
