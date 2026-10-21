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
import {
  FileImage, FilePenLine, Layers, Merge, Minimize2, PenLine, QrCode, Scissors, Shield,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
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
  icon: LucideIcon;
  route: string;
  /**
   * Marks a feature the product still considers unstable. The badge is rendered
   * on both navigation surfaces so the warning cannot drift between them.
   */
  beta?: boolean;
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
    id: 'merge', name: t('Merge PDF'), group: 'organize', icon: Merge,
    description: t('Combine several PDFs into one, in the order you choose.'), route: '/merge',
  },
  {
    id: 'extract', name: t('Split PDF'), group: 'organize', icon: Scissors,
    description: t('Take out the pages or ranges you need as a new document.'), route: '/extract',
  },
  {
    id: 'organize', name: t('Organize PDF'), group: 'organize', icon: Layers,
    description: t('Reorder, rotate, mirror, delete, and insert pages visually.'), route: '/organize',
  },
  {
    id: 'converter', name: t('PDF & Image'), group: 'convert', icon: FileImage,
    description: t('Turn PDF pages into images, or images into a single PDF.'), route: '/converter',
  },
  {
    id: 'edit-canvas', name: t('Canvas PDF'), group: 'edit', icon: PenLine,
    description: t('Add text, shapes, images, drawings, and highlights onto a page.'), route: '/edit-canvas',
  },
  {
    id: 'edit-content', name: t('Edit Content'), group: 'edit', icon: FilePenLine,
    description: t('Correct existing text in a PDF, verified before it is saved.'), route: '/edit-content',
    beta: true,
  },
  {
    id: 'compress', name: t('Compress PDF'), group: 'optimize', icon: Minimize2,
    description: t('Reduce file size while keeping the document readable.'), route: '/compress',
  },
  {
    id: 'protect', name: t('Protect PDF'), group: 'protect', icon: Shield,
    description: t('Add or remove password protection and permissions.'), route: '/protect',
  },
  {
    id: 'qr-barcode', name: t('QR & Barcode'), group: 'create', icon: QrCode,
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
