import { describe, expect, it } from 'vitest';

import {
  normaliseSearch,
  searchSettings,
  type SettingsSearchItem,
} from './settings-search';

const ITEMS: SettingsSearchItem[] = [
  {
    section: 'profile',
    label: 'Profile',
    terms: 'My account Your name, photo and how teammates see you. avatar',
  },
  {
    section: 'security',
    label: 'Login & security',
    terms: 'My account Change your password. password 2fa sessions',
  },
  {
    section: 'teams',
    label: 'Teams',
    terms: 'Workspace Group people under a leader.',
  },
  {
    section: 'team-chat',
    label: 'Team chat',
    terms: 'Cases & collaboration Internal chat on or off.',
  },
  {
    section: 'templates',
    label: 'Templates',
    terms: 'WhatsApp Message templates and their Meta approval.',
  },
  {
    section: 'routing',
    label: 'Routing',
    terms: 'WhatsApp Which number sends broadcasts and templates.',
  },
];

describe('normaliseSearch', () => {
  it('folds case, accents and whitespace', () => {
    expect(normaliseSearch('  Teléfono   SISTEMA ')).toBe('telefono sistema');
  });

  it('decomposes Hangul so a half-typed syllable still matches', () => {
    // 프로ㅍ is what the IME shows on the way to 프로필.
    expect(normaliseSearch('프로필').includes(normaliseSearch('프로ㅍ'))).toBe(
      true
    );
  });
});

describe('searchSettings', () => {
  it('matches nothing for an empty or blank query', () => {
    expect(searchSettings('', ITEMS)).toEqual([]);
    expect(searchSettings('   ', ITEMS)).toEqual([]);
  });

  it('finds a section by its label, any case', () => {
    expect(searchSettings('PROFILE', ITEMS)).toEqual(['profile']);
  });

  it('finds a section by a word only its hint or keywords hold', () => {
    expect(searchSettings('password', ITEMS)).toEqual(['security']);
    expect(searchSettings('avatar', ITEMS)).toEqual(['profile']);
  });

  it('needs every word of the query, in any order', () => {
    expect(searchSettings('chat internal', ITEMS)).toEqual(['team-chat']);
    expect(searchSettings('chat password', ITEMS)).toEqual([]);
  });

  it('ranks a label prefix, then a label match, then the rest', () => {
    // "Templates" starts with it; "Routing" only mentions templates.
    expect(searchSettings('templ', ITEMS)).toEqual(['templates', 'routing']);
    // Both labels start with "team": menu order breaks the tie.
    expect(searchSettings('team', ITEMS)).toEqual([
      'teams',
      'team-chat',
      'profile',
    ]);
    // "security" sits inside the label "Login & security".
    expect(searchSettings('security', ITEMS)).toEqual(['security']);
  });

  it('keeps menu order among equally ranked hits', () => {
    expect(searchSettings('whatsapp', ITEMS)).toEqual(['templates', 'routing']);
  });
});
