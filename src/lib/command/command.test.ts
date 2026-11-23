import { describe, expect, it } from 'vitest';

import { buildCommandEntries, visibleNavEntries } from './entries';
import { moveHighlight, rankEntries, scoreText } from './filter';
import {
  CHORD_TIMEOUT_MS,
  IDLE_CHORD,
  isOpenShortcut,
  isTypingTarget,
  stepShortcut,
  type KeyInfo,
  type ShortcutContext,
} from './keys';
import { isApplePlatform, modifierKeyName } from './platform';
import { listShortcuts } from './shortcuts';
import { chatHref, contactHref, isSearchable } from './contact-search';
import type { AccountRole } from '@/lib/auth/roles';

const key = (k: string, extra: Partial<KeyInfo> = {}): KeyInfo => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
});

const ctxFor = (hrefs: string[], extra: Partial<ShortcutContext> = {}) => ({
  allowedHrefs: new Set(hrefs),
  typing: false,
  dialogOpen: false,
  ...extra,
});

describe('platform', () => {
  it('shows Cmd on Apple platforms and Ctrl elsewhere', () => {
    expect(modifierKeyName(isApplePlatform({ platform: 'MacIntel' }))).toBe(
      'Cmd'
    );
    expect(modifierKeyName(isApplePlatform({ platform: 'iPhone' }))).toBe(
      'Cmd'
    );
    expect(modifierKeyName(isApplePlatform({ platform: 'Win32' }))).toBe(
      'Ctrl'
    );
    expect(modifierKeyName(isApplePlatform({ userAgent: 'X11; Linux' }))).toBe(
      'Ctrl'
    );
    expect(modifierKeyName(isApplePlatform(undefined))).toBe('Ctrl');
  });
});

describe('open shortcut', () => {
  it('is Ctrl+K or Cmd+K only', () => {
    expect(isOpenShortcut(key('k', { ctrlKey: true }))).toBe(true);
    expect(isOpenShortcut(key('K', { metaKey: true }))).toBe(true);
    expect(isOpenShortcut(key('k'))).toBe(false);
    expect(isOpenShortcut(key('k', { ctrlKey: true, shiftKey: true }))).toBe(
      false
    );
    expect(isOpenShortcut(key('k', { ctrlKey: true, altKey: true }))).toBe(
      false
    );
    expect(isOpenShortcut(key('j', { ctrlKey: true }))).toBe(false);
    // Chrome's autofill dispatches a keydown with no key.
    expect(
      isOpenShortcut({ ...key('k', { ctrlKey: true }), key: undefined })
    ).toBe(false);
    expect(
      stepShortcut(IDLE_CHORD, { ...key('g'), key: undefined }, 0, {
        allowedHrefs: new Set(),
        typing: false,
        dialogOpen: false,
      }).action
    ).toBeNull();
  });
});

describe('typing targets', () => {
  it('covers fields and editable content', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'textarea' })).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(
      true
    );
    expect(isTypingTarget({ tagName: 'DIV', role: 'textbox' })).toBe(true);
    // Type-ahead in an open menu or list is typing too.
    expect(isTypingTarget({ tagName: 'DIV', insideMenu: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'BODY' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('g chords', () => {
  const all = ctxFor(['/inbox', '/worklist', '/contacts', '/cases']);

  it('goes to each screen', () => {
    for (const [k, href] of [
      ['i', '/inbox'],
      ['w', '/worklist'],
      ['c', '/contacts'],
      ['k', '/cases'],
    ]) {
      const a = stepShortcut(IDLE_CHORD, key('g'), 0, all);
      expect(a.action).toBeNull();
      const b = stepShortcut(a.state, key(k), 500, all);
      expect(b.action).toEqual({ type: 'navigate', href });
      expect(b.state).toEqual(IDLE_CHORD);
    }
  });

  it('times out after a second', () => {
    const a = stepShortcut(IDLE_CHORD, key('g'), 0, all);
    const late = stepShortcut(a.state, key('i'), CHORD_TIMEOUT_MS + 1, all);
    expect(late.action).toBeNull();
    const edge = stepShortcut(a.state, key('i'), CHORD_TIMEOUT_MS, all);
    expect(edge.action).not.toBeNull();
  });

  it('only works for screens in the allowed nav', () => {
    const noCases = ctxFor(['/inbox']);
    const a = stepShortcut(IDLE_CHORD, key('g'), 0, noCases);
    expect(stepShortcut(a.state, key('k'), 10, noCases).action).toBeNull();
    expect(stepShortcut(a.state, key('i'), 10, noCases).action).toEqual({
      type: 'navigate',
      href: '/inbox',
    });
  });

  it('is ignored while typing, in a dialog, or with a modifier', () => {
    for (const c of [
      ctxFor(['/inbox'], { typing: true }),
      ctxFor(['/inbox'], { dialogOpen: true }),
    ]) {
      expect(stepShortcut(IDLE_CHORD, key('g'), 0, c).state).toEqual(
        IDLE_CHORD
      );
      expect(stepShortcut(IDLE_CHORD, key('?'), 0, c).action).toBeNull();
    }
    expect(
      stepShortcut(IDLE_CHORD, key('g', { ctrlKey: true }), 0, all).state
    ).toEqual(IDLE_CHORD);
    const a = stepShortcut(IDLE_CHORD, key('g'), 0, all);
    expect(
      stepShortcut(a.state, key('i', { metaKey: true }), 10, all).action
    ).toBeNull();
    expect(
      stepShortcut(a.state, key('i', { shiftKey: true }), 10, all).action
    ).toBeNull();
  });

  it('a wrong second key cancels, g g i still works', () => {
    const a = stepShortcut(IDLE_CHORD, key('g'), 0, all);
    expect(stepShortcut(a.state, key('x'), 10, all).state).toEqual(IDLE_CHORD);
    const b = stepShortcut(a.state, key('g'), 10, all);
    expect(stepShortcut(b.state, key('i'), 20, all).action).not.toBeNull();
  });

  it('? opens the shortcut list', () => {
    expect(
      stepShortcut(IDLE_CHORD, key('?', { shiftKey: true }), 0, all).action
    ).toEqual({ type: 'help' });
  });
});

describe('listShortcuts', () => {
  it('lists go-to rows only for allowed screens', () => {
    const rows = listShortcuts(new Set(['/inbox', '/cases']));
    expect(rows.map((r) => r.keys.join(' '))).toEqual([
      'mod k',
      '?',
      'g i',
      'g k',
    ]);
  });
});

describe('filter', () => {
  it('scores prefix above word start above substring above keyword', () => {
    const p = scoreText('con', 'Contacts');
    const w = scoreText('rec', 'Team recordings');
    const s = scoreText('tact', 'Contacts');
    const k = scoreText('sms', 'Templates', 'sms text');
    expect(p).toBeGreaterThan(w);
    expect(w).toBeGreaterThan(s);
    expect(s).toBeGreaterThan(k);
    expect(k).toBeGreaterThan(0);
    expect(scoreText('zzz', 'Contacts')).toBe(0);
  });

  it('needs every word to match', () => {
    expect(scoreText('team rec', 'Team recordings')).toBeGreaterThan(0);
    expect(scoreText('team xyz', 'Team recordings')).toBe(0);
  });

  it('hides searchOnly entries until something is typed', () => {
    const entries = buildCommandEntries({ role: 'admin', nav: {} }, false);
    const textOf = (e: { id: string }) => ({ label: e.id });
    const idle = rankEntries(entries, '', textOf);
    expect(idle.some((e) => e.kind === 'setting')).toBe(false);
    const typed = rankEntries(entries, 'setting:members', textOf);
    expect(typed.map((e) => e.id)).toContain('setting:members');
  });

  it('wraps the highlight', () => {
    expect(moveHighlight(2, 3, 'ArrowDown')).toBe(0);
    expect(moveHighlight(0, 3, 'ArrowUp')).toBe(2);
    expect(moveHighlight(1, 3, 'Home')).toBe(0);
    expect(moveHighlight(1, 3, 'End')).toBe(2);
    expect(moveHighlight(0, 0, 'ArrowDown')).toBe(0);
  });
});

const ids = (role: AccountRole | null, restricted = false) =>
  buildCommandEntries(
    { role, nav: { salesRestricted: restricted } },
    restricted
  ).map((e) => e.id);

describe('role gating', () => {
  it('a bank guest gets only team chat, Workspaces and help', () => {
    const list = ids('bank_guest');
    expect(list).toContain('page:/chat');
    expect(list).not.toContain('page:/inbox');
    expect(list).not.toContain('page:/settings');
    expect(list.filter((i) => i.startsWith('action:'))).toEqual([
      'action:shortcuts',
    ]);
    expect(list.filter((i) => i.startsWith('setting:'))).toEqual([
      'setting:workspaces',
    ]);
  });

  it('a viewer cannot add a contact or open admin screens', () => {
    const list = ids('viewer');
    expect(list).toContain('page:/contacts');
    expect(list).not.toContain('action:add-contact');
    expect(list).not.toContain('action:new-broadcast');
    expect(list).not.toContain('action:new-meeting');
    expect(list).not.toContain('setting:members');
  });

  it('an agent can add contacts but not broadcast or host meetings', () => {
    const list = ids('agent');
    expect(list).toContain('action:add-contact');
    expect(list).not.toContain('action:new-broadcast');
    expect(list).not.toContain('action:new-meeting');
    expect(list).toContain('page:/cases');
    expect(list).not.toContain('page:/team-inbox');
  });

  it('a team leader can host meetings', () => {
    expect(ids('team_leader')).toContain('action:new-meeting');
  });

  it('an admin gets broadcasts and every settings section', () => {
    const list = ids('admin');
    expect(list).toContain('action:new-broadcast');
    expect(list).toContain('setting:members');
    expect(list).toContain('setting:api');
  });

  it('a restricted department loses sales areas and their actions', () => {
    const list = ids('admin', true);
    expect(list).not.toContain('page:/broadcasts');
    expect(list).not.toContain('action:new-broadcast');
    expect(list).not.toContain('setting:templates');
  });

  it('while the role loads only ungated pages show, no actions', () => {
    const list = ids(null);
    expect(list.filter((i) => i.startsWith('action:'))).toEqual([
      'action:shortcuts',
    ]);
    expect(list.some((i) => i.startsWith('setting:'))).toBe(false);
  });

  it('page entries equal the sidebar rows', () => {
    const pages = visibleNavEntries({ role: 'agent', nav: {} });
    expect(pages.map((p) => p.href)).toContain('/worklist');
    expect(new Set(pages.map((p) => p.id)).size).toBe(pages.length);
  });
});

describe('contact search helpers', () => {
  it('needs two characters', () => {
    expect(isSearchable('a')).toBe(false);
    expect(isSearchable(' a ')).toBe(false);
    expect(isSearchable('ab')).toBe(true);
  });

  it('builds links', () => {
    expect(contactHref('abc')).toBe('/contacts/abc');
    expect(chatHref('x y')).toBe('/inbox?c=x%20y');
  });
});
