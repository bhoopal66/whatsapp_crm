import { describe, expect, it } from 'vitest';

import { infoSectionFromTab, infoSections, type GroupTab } from './group-page';

const all: GroupTab[] = [
  'chat',
  'members',
  'settings',
  'invite',
  'requests',
  'managers',
];
const open = { edit_info: null, settings: null } as const;

describe('infoSections', () => {
  it('orders the visible tabs as the panel shows them', () => {
    expect(infoSections(all, open)).toEqual([
      'members',
      'invite',
      'requests',
      'settings',
      'managers',
    ]);
  });

  it('leaves out what visibleTabs hides (Requests, Managers)', () => {
    expect(
      infoSections(['chat', 'members', 'settings', 'invite'], open)
    ).toEqual(['members', 'invite', 'settings']);
  });

  it('hides Settings only when both halves are blocked', () => {
    expect(
      infoSections(all, { edit_info: 'not_group_admin', settings: null })
    ).toContain('settings');
    expect(
      infoSections(all, { edit_info: null, settings: 'not_group_admin' })
    ).toContain('settings');
    expect(
      infoSections(all, { edit_info: 'not_allowed', settings: 'not_allowed' })
    ).not.toContain('settings');
  });
});

describe('infoSectionFromTab', () => {
  const sections = infoSections(all, open);

  it('maps an old ?tab= to its section', () => {
    expect(infoSectionFromTab('requests', sections)).toBe('requests');
    expect(infoSectionFromTab('members', sections)).toBe('members');
  });

  it('reads chat, nothing, an unknown or a hidden tab as no section', () => {
    expect(infoSectionFromTab('chat', sections)).toBeNull();
    expect(infoSectionFromTab(null, sections)).toBeNull();
    expect(infoSectionFromTab('bogus', sections)).toBeNull();
    expect(infoSectionFromTab('managers', ['members', 'invite'])).toBeNull();
  });
});
