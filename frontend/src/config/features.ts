/**
 * The single feature registry.
 *
 * Both navigation surfaces read from here — the sidebar and the Home cards — so
 * adding or moving a feature means editing one entry rather than two lists that
 * can drift apart.
 *
 * Features are grouped by the task the user is performing, not by file type, so
 * tools that are not about PDFs fit the same structure without regrouping.
 */
import { FEATURE_ICONS, type IconComponent } from '../components/icons';
import type { NavItemId } from '../types';
import { t } from '../i18n';

export type FeatureGroupId =
  | 'organize' | 'convert' | 'edit' | 'optimize' | 'protect' | 'create';

export interface FeatureEntry {
  id: NavItemId;
  /** Displayed name; must not repeat its group's name. */
  name: string;
  /** One line, shown on the Home card. */
  description: string;
  group: FeatureGroupId;
  icon: IconComponent;
  route: string;
  /**
   * Marks a feature the product still considers unstable. The badge is rendered
   * on both navigation surfaces so the warning cannot drift between them.
   */
  beta?: boolean;
  /** Tooltip for this feature's BETA badge when it needs more than the shared wording. */
  betaNote?: string;
}

/**
 * The single tooltip for the BETA badge, on the sidebar item and the Home card.
 */
export const BETA_TOOLTIP = t('Beta: this feature is still unstable.');

/** Group order defines the order on both surfaces. */
export const FEATURE_GROUPS: { id: FeatureGroupId; label: string }[] = [
  { id: 'organize', label: t('Organize') },
  { id: 'convert', label: t('Convert') },
  { id: 'edit', label: t('Edit') },
  { id: 'optimize', label: t('Optimize') },
  { id: 'protect', label: t('Protect') },
  { id: 'create', label: t('Create') },
];

export const FEATURES: FeatureEntry[] = [
  {
    id: 'merge', name: t('Merge PDF'), group: 'organize', icon: FEATURE_ICONS['merge'],
    description: t('Combine several PDFs into one, in the order you choose.'), route: '/merge',
  },
  {
    id: 'extract', name: t('Split PDF'), group: 'organize', icon: FEATURE_ICONS['extract'],
    description: t('Take out the pages or ranges you need as a new document.'), route: '/extract',
  },
  {
    id: 'organize', name: t('Organize PDF'), group: 'organize', icon: FEATURE_ICONS['organize'],
    description: t('Reorder, rotate, mirror, delete, and insert pages visually.'), route: '/organize',
  },
  {
    id: 'converter', name: t('PDF & Image'), group: 'convert', icon: FEATURE_ICONS['converter'],
    description: t('Turn PDF pages into images, or images into a single PDF.'), route: '/converter',
  },
  {
    id: 'pdf-to-word', name: t('PDF to Word'), group: 'convert', icon: FEATURE_ICONS['pdf-to-word'],
    description: t('Turn a PDF into an editable Word document.'), route: '/pdf-to-word',
  },
  {
    id: 'image-format', name: t('WEBP to PNG/JPG'), group: 'convert', icon: FEATURE_ICONS['image-format'],
    description: t('Convert WEBP images to PNG, JPG, or JPEG, many at once.'), route: '/image-format',
  },
  {
    id: 'edit-canvas', name: t('Canvas PDF'), group: 'edit', icon: FEATURE_ICONS['edit-canvas'],
    description: t('Add text, shapes, images, drawings, and highlights onto a page.'), route: '/edit-canvas',
  },
  {
    id: 'edit-content', name: t('Edit Content'), group: 'edit', icon: FEATURE_ICONS['edit-content'],
    description: t('Correct existing text in a PDF, verified before it is saved.'), route: '/edit-content',
    beta: true,
  },
  {
    id: 'compress', name: t('Compress PDF'), group: 'optimize', icon: FEATURE_ICONS['compress'],
    description: t('Reduce file size while keeping the document readable.'), route: '/compress',
  },
  {
    id: 'photo-compress', name: t('Compress Photos'), group: 'optimize', icon: FEATURE_ICONS['photo-compress'],
    description: t('Make JPEG and PNG photos smaller, many at once.'), route: '/photo-compress',
  },
  {
    id: 'protect', name: t('Protect PDF'), group: 'protect', icon: FEATURE_ICONS['protect'],
    description: t('Add or remove password protection and permissions.'), route: '/protect',
  },
  {
    id: 'qr-barcode', name: t('QR & Barcode'), group: 'create', icon: FEATURE_ICONS['qr-barcode'],
    description: t('Generate a QR code or barcode and save it as an image.'), route: '/qr-barcode',
  },
];

/** Navigation entries that are not features, so Home does not render them as cards. */
export const HOME_ENTRY = { id: 'home' as const, name: t('Home'), route: '/' };
export const DONATION_ENTRY = { id: 'donation' as const, name: t('Donation'), route: '/donation' };
export const SETTINGS_ENTRY = { id: 'settings' as const, name: 'Settings', route: '/settings' };

export interface FeatureGroup {
  id: FeatureGroupId;
  label: string;
  features: FeatureEntry[];
}

/** Features grouped in the registry's order, with no empty groups. */
export function featuresByGroup(): FeatureGroup[] {
  return FEATURE_GROUPS.map((group) => ({
    ...group,
    features: FEATURES.filter((feature) => feature.group === group.id),
  }));
}
