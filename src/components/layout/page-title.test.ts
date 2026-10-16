import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';

import { PAGE_TITLE_KEYS, pageTitleKey } from './page-title';

describe('pageTitleKey', () => {
  it.each([
    ['/dashboard', 'dashboard'],
    ['/inbox', 'inbox'],
    ['/team-inbox', 'teamInbox'],
    ['/calls', 'calls'],
    ['/groups', 'whatsappGroups'],
    ['/groups/g1', 'whatsappGroups'],
    ['/calendar', 'calendar'],
    ['/meetings', 'meetings'],
    ['/meetings/abc/room', 'meetings'],
    ['/chat', 'chat'],
    ['/chat/rooms/r1', 'chat'],
    ['/journeys', 'journeys'],
    ['/notifications', 'notifications'],
    ['/contacts', 'contacts'],
    ['/contacts/5f0c', 'customer'],
    ['/team-contacts', 'teamContacts'],
    ['/pipelines', 'pipelines'],
    ['/broadcasts/new', 'broadcasts'],
    ['/automations/1/edit', 'automations'],
    ['/flows/1/runs', 'flows'],
    ['/compass', 'compass'],
    ['/team-activity', 'teamActivity'],
    ['/settings', 'settings'],
    ['/agents', 'settings'],
  ])('%s → %s', (path, key) => {
    expect(pageTitleKey(path)).toBe(key);
  });

  it('matches whole segments, not string prefixes', () => {
    expect(pageTitleKey('/chatter')).toBe('dashboard');
    expect(pageTitleKey('/inbox-old')).toBe('dashboard');
  });

  it('ignores a query, a hash and a trailing slash', () => {
    expect(pageTitleKey('/contacts/?q=1')).toBe('contacts');
    expect(pageTitleKey('/calls#x')).toBe('calls');
  });

  it('falls back to the dashboard', () => {
    expect(pageTitleKey('/')).toBe('dashboard');
    expect(pageTitleKey(null)).toBe('dashboard');
  });

  it('has a title for every dashboard route on disk', () => {
    const root = join(__dirname, '../../app/(dashboard)');
    const tops = readdirSync(root).filter((d) =>
      statSync(join(root, d)).isDirectory()
    );
    expect(tops.length).toBeGreaterThan(10);
    for (const dir of tops.filter((d) => d !== 'dashboard'))
      expect(pageTitleKey(`/${dir}`), `/${dir} has no title`).not.toBe(
        'dashboard'
      );
  });

  it('names a title in both catalogues', () => {
    for (const key of PAGE_TITLE_KEYS) {
      expect((en.Header as Record<string, string>)[key], key).toBeTruthy();
      expect((ko.Header as Record<string, string>)[key], key).toBeTruthy();
    }
  });
});
