import { BrandLogo } from '../BrandLogo';
import type { IconComponent } from './index';

/** The Dokuwu mark as a page-header icon (Home). It keeps its own colours, like the feature glyphs. */
export const BrandMark: IconComponent = ({ size = 24, className }) => (
  <BrandLogo variant="mark" size={size} className={['brand-mark', className].filter(Boolean).join(' ')} />
);
BrandMark.displayName = 'BrandMark';
