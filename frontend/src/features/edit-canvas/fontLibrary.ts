import apiClient from '../../api/client';

export interface ApplicationFontEntry {
  id: string;
  family: string;
  filename: string;
  weight: number;
  bold: boolean;
  italic: boolean;
}

interface FontListResponse {
  fonts: Array<Partial<ApplicationFontEntry> & Pick<ApplicationFontEntry, 'id' | 'family' | 'filename'>>;
}

export interface ApplicationFontLoadResult {
  families: string[];
  entries: ApplicationFontEntry[];
}

export const BUILT_IN_FONT_WEIGHTS: Readonly<Record<string, readonly number[]>> = {
  Arial: [400, 700],
  'Times New Roman': [400, 700],
  Calibri: [300, 400, 700],
  Cambria: [400, 700],
  Georgia: [400, 700],
  Verdana: [400, 700],
  'Trebuchet MS': [400, 700],
  'Courier New': [400, 700],
  Tahoma: [400, 700],
  'Century Gothic': [400, 700],
};

const WEIGHT_LABELS: Readonly<Record<number, string>> = {
  100: 'Thin',
  200: 'Extra Light',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'Extra Bold',
  900: 'Black',
};

const registrationTasks = new Map<string, Promise<void>>();

function normalizeFamily(family: string): string {
  return family.trim().toLocaleLowerCase();
}

function normalizeEntry(entry: FontListResponse['fonts'][number]): ApplicationFontEntry {
  const weight = Number.isFinite(Number(entry.weight))
    ? Math.max(1, Math.min(1000, Math.round(Number(entry.weight))))
    : entry.bold ? 700 : 400;
  return {
    id: entry.id,
    family: entry.family,
    filename: entry.filename,
    weight,
    bold: weight >= 700,
    italic: Boolean(entry.italic),
  };
}

function uniqueSortedFamilies(families: string[]): string[] {
  return Array.from(new Set(families.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

export function mergeFontFamilies(builtIn: string[], application: string[]): string[] {
  const builtInKeys = new Set(builtIn.map(normalizeFamily));
  const custom = uniqueSortedFamilies(application)
    .filter((family) => !builtInKeys.has(normalizeFamily(family)));
  return [...builtIn, ...custom];
}

export function nearestAvailableFontWeight(requested: number, available: readonly number[]): number {
  if (available.length === 0) return 400;
  const target = Math.max(1, Math.min(1000, Math.round(Number(requested) || 400)));
  return [...available].sort((left, right) => {
    const distance = Math.abs(left - target) - Math.abs(right - target);
    if (distance !== 0) return distance;
    return target >= 500 ? right - left : left - right;
  })[0];
}

export function getAvailableFontWeights(
  family: string,
  entries: readonly ApplicationFontEntry[],
): number[] {
  const key = normalizeFamily(family);
  const applicationWeights = entries
    .filter((entry) => normalizeFamily(entry.family) === key)
    .map((entry) => entry.weight);
  const builtInWeights = Object.entries(BUILT_IN_FONT_WEIGHTS)
    .find(([name]) => normalizeFamily(name) === key)?.[1] ?? [];
  const weights = Array.from(new Set([...builtInWeights, ...applicationWeights])).sort((left, right) => left - right);
  return weights.length > 0 ? weights : [400, 700];
}

export function getFontWeightLabel(weight: number): string {
  return `${WEIGHT_LABELS[weight] ?? `Weight ${weight}`} · ${weight}`;
}

export function toggleBoldWeight(current: number, available: readonly number[]): number {
  return nearestAvailableFontWeight(current >= 700 ? 400 : 700, available);
}

function selectApplicationFontEntry(
  entries: readonly ApplicationFontEntry[],
  family: string,
  weight: number,
  italic: boolean,
): ApplicationFontEntry | null {
  const key = normalizeFamily(family);
  const matches = entries.filter((entry) => normalizeFamily(entry.family) === key);
  if (matches.length === 0) return null;
  return [...matches].sort((left, right) => {
    const styleDifference = Number(left.italic !== italic) - Number(right.italic !== italic);
    if (styleDifference !== 0) return styleDifference;
    const weightDifference = Math.abs(left.weight - weight) - Math.abs(right.weight - weight);
    if (weightDifference !== 0) return weightDifference;
    return weight >= 500 ? right.weight - left.weight : left.weight - right.weight;
  })[0];
}

export async function ensureApplicationFontFace(
  entries: readonly ApplicationFontEntry[],
  family: string,
  weight: number,
  italic: boolean,
): Promise<boolean> {
  const entry = selectApplicationFontEntry(entries, family, weight, italic);
  if (!entry) return false;
  if (typeof FontFace === 'undefined' || !document.fonts) {
    throw new Error('This browser cannot register application fonts.');
  }

  let task = registrationTasks.get(entry.id);
  if (!task) {
    task = (async () => {
      const response = await apiClient.get<ArrayBuffer>(
        `/api/v1/fonts/${encodeURIComponent(entry.id)}/file`,
        { responseType: 'arraybuffer' },
      );
      const face = new FontFace(entry.family, response.data, {
        weight: String(entry.weight),
        style: entry.italic ? 'italic' : 'normal',
      });
      const loadedFace = await face.load();
      document.fonts.add(loadedFace);
    })();
    registrationTasks.set(entry.id, task);
  }

  try {
    await task;
    return true;
  } catch (error) {
    registrationTasks.delete(entry.id);
    throw error;
  }
}

export async function loadApplicationFontLibrary(): Promise<ApplicationFontLoadResult> {
  const response = await apiClient.get<FontListResponse>('/api/v1/fonts');
  const entries = (Array.isArray(response.data.fonts) ? response.data.fonts : []).map(normalizeEntry);
  return {
    families: uniqueSortedFamilies(entries.map((entry) => entry.family)),
    entries,
  };
}
