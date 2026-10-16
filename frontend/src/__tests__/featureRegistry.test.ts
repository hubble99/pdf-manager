import { describe, expect, it } from 'vitest';
import { APP_DESCRIPTION, APP_NAME, APP_TAGLINE } from '../config/app';
import {
  DONATION_ENTRY, FEATURE_GROUPS, FEATURES, HOME_ENTRY, SETTINGS_ENTRY, featuresByGroup,
} from '../config/features';

const expectedFeatureIds = [
  'merge', 'extract', 'organize', 'converter', 'edit-canvas',
  'edit-content', 'compress', 'protect', 'qr-barcode',
].sort();

describe('feature registry', () => {
  it('holds every feature exactly once', () => {
    const ids = FEATURES.map((feature) => feature.id).sort();
    expect(ids).toEqual(expectedFeatureIds);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every feature a route that is unique', () => {
    const routes = FEATURES.map((feature) => feature.route);
    expect(routes.every((route) => route.startsWith('/'))).toBe(true);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('describes every feature for its Home card', () => {
    for (const feature of FEATURES) {
      expect(feature.name.length, feature.id).toBeGreaterThan(2);
      expect(feature.description.length, feature.id).toBeGreaterThan(15);
      expect(feature.icon, feature.id).toBeTruthy();
    }
  });

  it('keeps every group non-empty and in the declared order', () => {
    const groups = featuresByGroup();
    expect(groups.map((group) => group.id)).toEqual(FEATURE_GROUPS.map((group) => group.id));
    for (const group of groups) {
      expect(group.features.length, group.id).toBeGreaterThan(0);
    }
  });

  it('places each feature in a declared group', () => {
    const declared = new Set(FEATURE_GROUPS.map((group) => group.id));
    for (const feature of FEATURES) {
      expect(declared.has(feature.group), feature.id).toBe(true);
    }
  });

  it('does not let a feature repeat its own group name', () => {
    // The reason "Organize Pages" became "Organize PDF".
    for (const group of featuresByGroup()) {
      for (const feature of group.features) {
        expect(feature.name.toLowerCase(), feature.id).not.toBe(group.label.toLowerCase());
      }
    }
  });

  it('groups by task so non-PDF tools have a home', () => {
    // Convert exists for the announced non-PDF conversion tools even though it
    // holds a single feature today.
    expect(FEATURE_GROUPS.map((group) => group.id)).toEqual([
      'organize', 'convert', 'edit', 'optimize', 'protect', 'create',
    ]);
    expect(featuresByGroup().find((group) => group.id === 'convert')?.features).toHaveLength(1);
  });

  it('keeps the non-feature entries out of the feature list', () => {
    const featureIds = new Set(FEATURES.map((feature) => feature.id as string));
    for (const entry of [HOME_ENTRY, DONATION_ENTRY, SETTINGS_ENTRY]) {
      expect(featureIds.has(entry.id)).toBe(false);
      expect(entry.route.startsWith('/')).toBe(true);
    }
  });

  it('exposes product identity from one place', () => {
    expect(APP_NAME.length).toBeGreaterThan(2);
    expect(APP_TAGLINE.length).toBeGreaterThan(15);
    // The description must survive the arrival of non-PDF tools.
    expect(APP_DESCRIPTION.toLowerCase()).not.toMatch(/\bpdf only\b/);
    expect(APP_DESCRIPTION.toLowerCase()).toMatch(/device|local|never uploaded/);
  });
});
