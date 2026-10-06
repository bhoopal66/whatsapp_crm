import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  RAIL_GROUPS,
  SECTION_META,
  SETTINGS_SECTIONS,
  canOpenSection,
  type SettingsSection,
} from './settings-sections';

// `canOpenSection` is the single gate behind all three ways into a
// settings section — the rail, the `?tab=` panel switch, and the
// Overview tiles. If it drifts, one of those surfaces starts showing
// a section the others hide.

const WORKSPACE: SettingsSection[] = [
  'whatsapp',
  'numbers',
  'costs',
  'templates',
  'quick-replies',
  'fields',
  'deals',
  'members',
  'teams',
  'api',
  'ai-safety',
];

const OPEN_TO_ALL: SettingsSection[] = ['overview', 'profile', 'security', 'appearance'];

describe('canOpenSection', () => {
  it('lets owners and admins into every workspace section', () => {
    for (const section of WORKSPACE) {
      expect(canOpenSection(section, 'owner')).toBe(true);
      expect(canOpenSection(section, 'admin')).toBe(true);
    }
  });

  it('keeps agents and viewers out of every workspace section', () => {
    for (const section of WORKSPACE) {
      expect(canOpenSection(section, 'agent')).toBe(false);
      expect(canOpenSection(section, 'viewer')).toBe(false);
    }
  });

  it('leaves the personal sections open to every role', () => {
    // These are the user's OWN settings — profile, password, theme —
    // and gating them would lock people out of their own account.
    for (const section of OPEN_TO_ALL) {
      for (const role of ['owner', 'admin', 'agent', 'viewer'] as const) {
        expect(canOpenSection(section, role)).toBe(true);
      }
    }
  });

  it('fails closed while the role is unknown', () => {
    // null = profile still loading. Answering "yes" here would flash
    // the gated sections into the rail and then yank them away.
    for (const section of WORKSPACE) {
      expect(canOpenSection(section, null)).toBe(false);
    }
    for (const section of OPEN_TO_ALL) {
      expect(canOpenSection(section, null)).toBe(true);
    }
  });

  it('covers every declared section, so a new one cannot be forgotten', () => {
    // A section added to SETTINGS_SECTIONS but to neither list above
    // would otherwise ship untested and silently ungated.
    expect([...WORKSPACE, ...OPEN_TO_ALL].sort()).toEqual([...SETTINGS_SECTIONS].sort());
  });

  it('gates exactly the workspace group', () => {
    // The grouping is what the UI renders; minRole is what enforces.
    // They must describe the same set.
    const gated = SETTINGS_SECTIONS.filter((s) => SECTION_META[s].minRole);
    const workspace = SETTINGS_SECTIONS.filter(
      (s) => SECTION_META[s].group === 'workspace',
    );
    expect([...gated].sort()).toEqual([...workspace].sort());
  });
});

// ------------------------------------------------------------
// Rail labels
//
// The rail renders every section through `t('sections.<id>')` and
// every named group through `t('groups.<group>')`. next-intl does not
// throw on a missing key — it reports MISSING_MESSAGE to onError and
// renders the keypath — so a section added here without a catalogue
// entry ships as a chip literally labelled "Settings.sections.teams".
// Nothing fails; it just looks broken. `messages.test.ts` cannot catch
// it either: it checks the translations cover en.json, and a key absent
// from BOTH is at parity.
// ------------------------------------------------------------

const LOCALES = readdirSync(join(process.cwd(), 'messages'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

function settingsCatalogue(locale: string): Record<string, Record<string, string>> {
  const raw = readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8');
  return JSON.parse(raw).Settings;
}

describe('rail labels', () => {
  it.each(LOCALES)('%s.json labels every section', (locale) => {
    const sections = settingsCatalogue(locale).sections ?? {};
    for (const section of SETTINGS_SECTIONS) {
      expect(sections[section], `missing Settings.sections.${section}`).toBeTruthy();
    }
  });

  it.each(LOCALES)('%s.json labels every named rail group', (locale) => {
    const groups = settingsCatalogue(locale).groups ?? {};
    for (const { label, group } of RAIL_GROUPS) {
      // A null label means the group renders no heading (the Overview
      // row) — nothing to translate.
      if (!label) continue;
      expect(groups[group], `missing Settings.groups.${group}`).toBeTruthy();
    }
  });
});
