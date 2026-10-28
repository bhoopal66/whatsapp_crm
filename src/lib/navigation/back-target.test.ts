import { beforeEach, describe, expect, it } from 'vitest';

import {
  BACK_LABEL_KEYS,
  MAX_ENTRIES,
  backLabelKey,
  backPlan,
  consumePopstate,
  notePopstate,
  previousLocation,
  recordNavigation,
  recordReplace,
  resetBackTarget,
} from './back-target';

// The tracker calls these exactly so: a popstate is noted at event
// time, then the effect records with the consumed flag.
function go(location: string) {
  recordNavigation(location, { popstate: consumePopstate(location) });
}
function pop(location: string) {
  notePopstate(location);
  go(location);
}

beforeEach(() => resetBackTarget());

describe('the location stack', () => {
  it('has no previous entry on the first page of a document', () => {
    go('/contacts/1');
    expect(previousLocation()).toBeNull();
  });

  it('pushes normal navigations', () => {
    go('/calls');
    go('/contacts/1');
    expect(previousLocation()).toBe('/calls');
  });

  it('calls -> customer -> case -> back: the customer page goes back to calls', () => {
    go('/calls');
    go('/contacts/1');
    go('/cases/9');
    expect(previousLocation()).toBe('/contacts/1');
    pop('/contacts/1');
    expect(previousLocation()).toBe('/calls');
  });

  it('pushes a popstate that does not land on the entry below (forward)', () => {
    go('/calls');
    go('/contacts/1');
    pop('/calls');
    expect(previousLocation()).toBeNull();
    pop('/contacts/1');
    expect(previousLocation()).toBe('/calls');
  });

  it('pushes a link to the page below the top (not a pop)', () => {
    go('/contacts/1');
    go('/cases/9');
    go('/contacts/1');
    expect(previousLocation()).toBe('/cases/9');
  });

  it('does not push consecutive duplicates', () => {
    go('/calls');
    go('/contacts/1');
    go('/contacts/1');
    expect(previousLocation()).toBe('/calls');
  });

  it('replaces the top on a same-path query change', () => {
    go('/calls');
    go('/contacts/1');
    go('/contacts/1?tab=calls');
    expect(previousLocation()).toBe('/calls');
  });

  it('keeps search on entries', () => {
    go('/calls?tab=missed');
    go('/contacts/1');
    expect(previousLocation()).toBe('/calls?tab=missed');
  });

  it(`keeps at most ${MAX_ENTRIES} entries`, () => {
    for (let i = 0; i < MAX_ENTRIES + 10; i++) go(`/contacts/${i}`);
    // Walk back over every kept entry: the last step has nothing below.
    for (let i = MAX_ENTRIES + 8; i >= 10; i--) {
      expect(previousLocation()).toBe(`/contacts/${i}`);
      pop(`/contacts/${i}`);
    }
    expect(previousLocation()).toBeNull();
  });
});

describe('planning during the first render of the new page', () => {
  it('counts the page being rendered before the tracker records it', () => {
    go('/calls');
    // /contacts/1 renders; the tracker has not recorded it yet.
    expect(previousLocation('/contacts/1')).toBe('/calls');
    expect(backPlan('/contacts', '/contacts/1')).toEqual({
      mode: 'history',
      label: 'calls',
    });
    go('/contacts/1');
    expect(previousLocation('/contacts/1')).toBe('/calls');
  });

  it('a Back-button return renders against the popped stack', () => {
    go('/calls');
    go('/contacts/1');
    go('/cases/9');
    notePopstate('/contacts/1');
    expect(previousLocation('/contacts/1')).toBe('/calls');
  });

  it('a link to the page below renders against the pushed stack', () => {
    go('/contacts/1');
    go('/cases/9');
    expect(previousLocation('/contacts/1')).toBe('/cases/9');
  });

  it('plans a link in a fresh document', () => {
    expect(backPlan('/contacts', '/contacts/1')).toEqual({
      mode: 'link',
      href: '/contacts',
      label: 'contacts',
    });
  });
});

describe('backPlan', () => {
  it('links to the fallback when nothing came before', () => {
    go('/contacts/1');
    expect(backPlan('/team-contacts')).toEqual({
      mode: 'link',
      href: '/team-contacts',
      label: 'teamContacts',
    });
  });

  it('goes back through history and names where it lands', () => {
    go('/calls');
    go('/contacts/1');
    expect(backPlan('/contacts')).toEqual({ mode: 'history', label: 'calls' });
  });
});

describe('backLabelKey', () => {
  it.each([
    ['/calls', 'calls'],
    ['/calls?tab=missed', 'calls'],
    ['/calls/report', 'callReport'],
    ['/inbox', 'inbox'],
    ['/team-inbox', 'teamInbox'],
    ['/contacts', 'contacts'],
    ['/contacts/1?from=team', 'customer'],
    ['/team-contacts', 'teamContacts'],
    ['/cases/9', 'case'],
    ['/banks/x', 'bank'],
    ['/chat/rooms/r1', 'chat'],
    ['/groups/g', 'group'],
    ['/submission-groups', 'submissionGroups'],
    ['/meetings/m', 'meeting'],
    ['/broadcasts/new', 'broadcasts'],
    ['/automations/a/logs', 'automations'],
    ['/flows/f/runs', 'flow'],
    ['/settings', 'settings'],
    ['/', 'back'],
    ['/somewhere-else', 'back'],
  ])('%s -> %s', (path, key) => {
    expect(backLabelKey(path)).toBe(key);
  });

  it('lists every key it can return', () => {
    expect(BACK_LABEL_KEYS).toContain('back');
    expect(new Set(BACK_LABEL_KEYS).size).toBe(BACK_LABEL_KEYS.length);
  });
});

describe('recordReplace (cross-path router.replace)', () => {
  it('fresh tab: the replaced page leaves the stack, so Back is a link', () => {
    go('/contacts?c=1');
    recordReplace('/contacts/1');
    go('/contacts/1'); // the tracker's record of the landing
    expect(backPlan('/contacts', '/contacts/1')).toEqual({
      mode: 'link',
      href: '/contacts',
      label: 'contacts',
    });
  });

  it('starts the stack when it is empty', () => {
    recordReplace('/contacts/1');
    go('/contacts/1');
    expect(previousLocation()).toBeNull();
  });

  it('in-app: label and destination agree on the page before the replaced one', () => {
    go('/calls');
    go('/contacts?c=1');
    recordReplace('/contacts/1');
    go('/contacts/1');
    expect(previousLocation()).toBe('/calls');
    expect(backPlan('/contacts', '/contacts/1')).toEqual({
      mode: 'history',
      label: 'calls',
    });
    pop('/calls');
    expect(previousLocation()).toBeNull();
  });
});
