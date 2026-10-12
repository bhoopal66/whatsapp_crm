import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SECTION_META,
  SETTINGS_CATEGORIES,
  SETTINGS_SECTIONS,
  agentsRedirectHref,
  canOpenSection,
  inAppLeaveTarget,
  leavesAiArea,
  resolveSettingsLocation,
  resolveSettingsTab,
  sectionsOf,
  settingsParamsFor,
  visibleCategories,
  type SettingsSection,
} from './settings-sections';

// `canOpenSection` is the single gate behind every way into a settings
// section — the tab rows, the `?tab=` panel switch, and the Overview
// tiles. If it drifts, one surface shows a section the others hide.

const ADMIN_ONLY: SettingsSection[] = [
  'whatsapp',
  'numbers',
  'routing',
  'templates',
  'costs',
  'chat-tags',
  'quick-replies',
  'fields',
  'journey-bot',
  'members',
  'teams',
  'team-chat',
  'ai',
  'api',
  'deals',
];

const OPEN_TO_ALL: SettingsSection[] = [
  'overview',
  'profile',
  'security',
  'appearance',
];

const params = (tab: string | null) =>
  new URLSearchParams(tab === null ? '' : `tab=${tab}`);

describe('canOpenSection', () => {
  it('lets owners and admins into every admin section', () => {
    for (const section of ADMIN_ONLY) {
      expect(canOpenSection(section, 'owner')).toBe(true);
      expect(canOpenSection(section, 'admin')).toBe(true);
    }
  });

  it('keeps leaders, agents and viewers out of every admin section', () => {
    for (const section of ADMIN_ONLY) {
      for (const role of ['team_leader', 'agent', 'viewer'] as const) {
        expect(canOpenSection(section, role)).toBe(false);
      }
    }
  });

  it('leaves the personal sections open to every role', () => {
    for (const section of OPEN_TO_ALL) {
      for (const role of ['owner', 'admin', 'agent', 'viewer'] as const) {
        expect(canOpenSection(section, role)).toBe(true);
      }
    }
  });

  it('fails closed while the role is unknown', () => {
    for (const section of ADMIN_ONLY)
      expect(canOpenSection(section, null)).toBe(false);
    for (const section of OPEN_TO_ALL)
      expect(canOpenSection(section, null)).toBe(true);
  });

  it('covers every declared section, so a new one cannot be forgotten', () => {
    expect([...ADMIN_ONLY, ...OPEN_TO_ALL].sort()).toEqual(
      [...SETTINGS_SECTIONS].sort()
    );
  });

  it('gates everything outside Overview and My account', () => {
    const gated = SETTINGS_SECTIONS.filter((s) => SECTION_META[s].minRole);
    const open = SETTINGS_SECTIONS.filter(
      (s) => !['overview', 'account'].includes(SECTION_META[s].category)
    );
    expect([...gated].sort()).toEqual([...open].sort());
  });
});

describe('categories', () => {
  it('puts every section in exactly the category the IA names', () => {
    expect(
      Object.fromEntries(SETTINGS_CATEGORIES.map((c) => [c, sectionsOf(c)]))
    ).toEqual({
      overview: ['overview'],
      account: ['profile', 'security', 'appearance'],
      whatsapp: ['whatsapp', 'numbers', 'routing', 'templates', 'costs'],
      inbox: ['chat-tags', 'quick-replies', 'fields', 'journey-bot'],
      team: ['members', 'teams', 'team-chat'],
      ai: ['ai'],
      integrations: ['api', 'deals'],
    });
  });

  it.each(['owner', 'admin'] as const)('shows %s every category', (role) => {
    expect(visibleCategories(role).map((c) => c.id)).toEqual([
      ...SETTINGS_CATEGORIES,
    ]);
  });

  it.each([null, 'team_leader', 'agent', 'viewer'] as const)(
    'hides the categories %s has no section in',
    (role) => {
      expect(visibleCategories(role)).toEqual([
        { id: 'overview', sections: ['overview'] },
        { id: 'account', sections: ['profile', 'security', 'appearance'] },
      ]);
    }
  );
});

describe('resolveSettingsTab', () => {
  it('resolves every section id to itself', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(resolveSettingsTab(section).section).toBe(section);
    }
  });

  it('keeps every legacy id working', () => {
    expect(resolveSettingsTab('tags')).toEqual({
      section: 'chat-tags',
      agentTab: null,
    });
    expect(resolveSettingsTab('custom-fields')).toEqual({
      section: 'fields',
      agentTab: null,
    });
    // The removed AI safety checks section now lives in AI Agents.
    expect(resolveSettingsTab('ai-safety')).toEqual({
      section: 'ai',
      agentTab: 'safety',
    });
  });

  it('carries the AI Agents tab in ?tab=ai-<tab>', () => {
    expect(resolveSettingsTab('ai')).toEqual({ section: 'ai', agentTab: null });
    expect(resolveSettingsTab('ai-auto-reply')).toEqual({
      section: 'ai',
      agentTab: 'auto-reply',
    });
    expect(resolveSettingsTab('ai-')).toEqual({
      section: 'ai',
      agentTab: null,
    });
  });

  it('sends anything unknown to the Overview', () => {
    for (const raw of [null, '', 'nope', 'groups']) {
      expect(resolveSettingsTab(raw)).toEqual({
        section: 'overview',
        agentTab: null,
      });
    }
  });
});

describe('resolveSettingsLocation', () => {
  it('derives the category from the sub-tab', () => {
    expect(resolveSettingsLocation(params('routing'), 'admin')).toEqual({
      section: 'routing',
      agentTab: null,
      category: 'whatsapp',
    });
    expect(resolveSettingsLocation(params('ai-safety'), 'owner')).toEqual({
      section: 'ai',
      agentTab: 'safety',
      category: 'ai',
    });
  });

  it('lands a role below the section on the Overview', () => {
    for (const tab of ['numbers', 'ai', 'ai-safety', 'tags', 'api']) {
      expect(resolveSettingsLocation(params(tab), 'agent')).toEqual({
        section: 'overview',
        agentTab: null,
        category: 'overview',
      });
    }
    expect(resolveSettingsLocation(params('security'), 'viewer').section).toBe(
      'security'
    );
  });
});

describe('settingsParamsFor', () => {
  it('drops section state when the sub-tab changes', () => {
    const next = settingsParamsFor(
      'tab=whatsapp&channel=c1&add=1&x=y',
      'numbers'
    );
    expect(next.toString()).toBe('tab=numbers&x=y');
  });

  it('keeps section state while the section stays the same', () => {
    const next = settingsParamsFor('tab=whatsapp&channel=c1', 'whatsapp');
    expect(next.get('channel')).toBe('c1');
  });
});

describe('agentsRedirectHref', () => {
  it('sends /agents to AI Agents in Settings, keeping its tab', () => {
    expect(agentsRedirectHref(undefined)).toBe('/settings?tab=ai');
    expect(agentsRedirectHref('playground')).toBe(
      '/settings?tab=ai-playground'
    );
    expect(agentsRedirectHref(['usage', 'x'])).toBe('/settings?tab=ai-usage');
    expect(agentsRedirectHref('setup')).toBe('/settings?tab=ai-assistant');
  });

  it('drops a tab value that is not an AI Agents tab', () => {
    for (const bad of ['nope', 'usage&add=1', '../profile', 'a b', '']) {
      expect(agentsRedirectHref(bad)).toBe('/settings?tab=ai');
    }
    expect(agentsRedirectHref([])).toBe('/settings?tab=ai');
  });
});

// ------------------------------------------------------------
// Labels. next-intl does not throw on a missing key — it renders the
// keypath — and `messages.test.ts` cannot catch a key absent from every
// catalogue, so check each tab label exists in each locale.
// ------------------------------------------------------------

const LOCALES = readdirSync(join(process.cwd(), 'messages'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

function settingsCatalogue(
  locale: string
): Record<string, Record<string, string>> {
  const raw = readFileSync(
    join(process.cwd(), 'messages', `${locale}.json`),
    'utf8'
  );
  return JSON.parse(raw).Settings;
}

describe('tab labels', () => {
  it.each(LOCALES)('%s.json labels every section', (locale) => {
    const sections = settingsCatalogue(locale).sections ?? {};
    for (const section of SETTINGS_SECTIONS) {
      expect(
        sections[section],
        `missing Settings.sections.${section}`
      ).toBeTruthy();
    }
  });

  it.each(LOCALES)('%s.json labels every category', (locale) => {
    const categories = settingsCatalogue(locale).categories ?? {};
    for (const category of SETTINGS_CATEGORIES) {
      expect(
        categories[category],
        `missing Settings.categories.${category}`
      ).toBeTruthy();
    }
  });
});

// Unsaved AI edits live only while the AI Agents area is mounted, so
// these two decide when the Settings page asks before navigating.
describe('leavesAiArea', () => {
  it('is true when the section goes from ai to anything else', () => {
    expect(leavesAiArea('ai', 'profile')).toBe(true);
    expect(leavesAiArea('ai-assistant', 'overview')).toBe(true);
    expect(leavesAiArea('ai-safety', 'api')).toBe(true);
    expect(leavesAiArea('ai', null)).toBe(true);
  });

  it('is false between AI Agents tabs', () => {
    expect(leavesAiArea('ai', 'ai-assistant')).toBe(false);
    expect(leavesAiArea('ai-assistant', 'ai-auto-reply')).toBe(false);
    expect(leavesAiArea('ai-safety', 'ai')).toBe(false);
  });

  it('is false when not starting in AI Agents', () => {
    expect(leavesAiArea('profile', 'members')).toBe(false);
    expect(leavesAiArea('routing', 'ai-auto-reply')).toBe(false);
    expect(leavesAiArea(null, 'whatsapp')).toBe(false);
  });
});

describe('inAppLeaveTarget', () => {
  const origin = 'https://crm.example.com';

  it('treats same-origin paths as leaving', () => {
    expect(inAppLeaveTarget('/inbox', origin)).toBe('/inbox');
    expect(inAppLeaveTarget('/contacts?q=a#top', origin)).toBe(
      '/contacts?q=a#top'
    );
    expect(inAppLeaveTarget(`${origin}/pipelines`, origin)).toBe('/pipelines');
  });

  it('treats other Settings sections as leaving', () => {
    expect(inAppLeaveTarget('/settings?tab=whatsapp', origin)).toBe(
      '/settings?tab=whatsapp'
    );
    expect(inAppLeaveTarget('/settings', origin)).toBe('/settings');
  });

  it('treats /agents as leaving (a fresh mount drops the edits)', () => {
    expect(inAppLeaveTarget('/agents', origin)).toBe('/agents');
    expect(inAppLeaveTarget('/agents?tab=safety', origin)).toBe(
      '/agents?tab=safety'
    );
  });

  it('stays for AI Agents tabs', () => {
    expect(inAppLeaveTarget('/settings?tab=ai', origin)).toBeNull();
    expect(inAppLeaveTarget('/settings?tab=ai-safety', origin)).toBeNull();
    expect(
      inAppLeaveTarget(`${origin}/settings?tab=ai-assistant`, origin)
    ).toBeNull();
  });

  it('ignores other origins and non-http schemes', () => {
    expect(inAppLeaveTarget('https://other.example.com/', origin)).toBeNull();
    expect(inAppLeaveTarget('http://crm.example.com/inbox', origin)).toBeNull();
    expect(inAppLeaveTarget('mailto:help@example.com', origin)).toBeNull();
    expect(inAppLeaveTarget('tel:+971500000000', origin)).toBeNull();
  });

  it('ignores hash-only and empty links', () => {
    expect(inAppLeaveTarget('#section', origin)).toBeNull();
    expect(inAppLeaveTarget('#', origin)).toBeNull();
    expect(inAppLeaveTarget('', origin)).toBeNull();
  });
});
