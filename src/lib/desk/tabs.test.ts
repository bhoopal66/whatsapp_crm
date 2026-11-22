import { describe, expect, it } from 'vitest';

import {
  DESK_SETTINGS_HREF,
  badgeText,
  deskTabHref,
  deskTabsFor,
  legacyDeskRedirect,
  resolveDeskTab,
  worklistTab,
} from './tabs';

describe('resolveDeskTab', () => {
  it('keeps a known tab', () => {
    expect(resolveDeskTab('tray', false)).toBe('tray');
    expect(resolveDeskTab('companies', false)).toBe('companies');
  });
  it('falls back to Upload for unknown or missing values', () => {
    for (const raw of ['nope', '', null, undefined, 'TRAY', 'codes'])
      expect(resolveDeskTab(raw, true)).toBe('upload');
  });
  it('hides Overview from people below team leader', () => {
    expect(resolveDeskTab('overview', false)).toBe('upload');
    expect(resolveDeskTab('overview', true)).toBe('overview');
    expect(deskTabsFor(false)).not.toContain('overview');
    expect(deskTabsFor(true)).toContain('overview');
  });
});

describe('links', () => {
  it('writes ?tab= except for the default tab', () => {
    expect(deskTabHref('upload')).toBe('/desk');
    expect(deskTabHref('tray')).toBe('/desk?tab=tray');
  });
  it('sends the old codes tab to Settings', () => {
    expect(legacyDeskRedirect('codes')).toBe(DESK_SETTINGS_HREF);
    expect(legacyDeskRedirect('tray')).toBeNull();
  });
  it('points each worklist row at its tab', () => {
    expect(worklistTab('tray')).toBe('tray');
    expect(worklistTab('queue')).toBe('queue');
    expect(worklistTab('mine')).toBe('mine');
    expect(worklistTab('tasks')).toBeNull();
  });
});

describe('badgeText', () => {
  it('shows nothing for zero or unknown', () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(null)).toBeNull();
    expect(badgeText(undefined)).toBeNull();
    expect(badgeText(NaN)).toBeNull();
  });
  it('caps big numbers', () => {
    expect(badgeText(3)).toBe('3');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
  });
});
