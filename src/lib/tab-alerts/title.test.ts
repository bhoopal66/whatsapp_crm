import { describe, expect, it } from 'vitest';

import { APP_NAME, formatTabTitle } from './title';
import { TitleOwner, type TitleTarget } from './title-owner';

describe('formatTabTitle', () => {
  it('leads with the unread count', () => {
    expect(formatTabTitle(3, 'Inbox')).toBe(`(3) Inbox — ${APP_NAME}`);
  });

  it('drops the count at zero and for nonsense', () => {
    expect(formatTabTitle(0, 'Inbox')).toBe(`Inbox — ${APP_NAME}`);
    expect(formatTabTitle(-2, 'Inbox')).toBe(`Inbox — ${APP_NAME}`);
    expect(formatTabTitle(Number.NaN, 'Inbox')).toBe(`Inbox — ${APP_NAME}`);
  });

  it('caps a large count', () => {
    expect(formatTabTitle(100, 'Inbox')).toBe(`(99+) Inbox — ${APP_NAME}`);
    expect(formatTabTitle(99, 'Inbox')).toBe(`(99) Inbox — ${APP_NAME}`);
  });

  it('is just the app name without a page name', () => {
    expect(formatTabTitle(0, '  ')).toBe(APP_NAME);
    expect(formatTabTitle(2, '')).toBe(`(2) ${APP_NAME}`);
  });
});

describe('TitleOwner', () => {
  const make = (initial = 'Taamul Connect') => {
    const doc: TitleTarget = { title: initial };
    return { doc, owner: new TitleOwner(() => doc) };
  };

  it('writes the base title while nothing flashes', () => {
    const { doc, owner } = make();
    owner.setBase('(1) Inbox — Taamul Connect');
    expect(doc.title).toBe('(1) Inbox — Taamul Connect');
  });

  it('puts the base back after something else changed the title', () => {
    const { doc, owner } = make();
    owner.setBase('(1) Inbox');
    doc.title = 'Taamul Connect'; // Next's metadata on navigation
    owner.reassert();
    expect(doc.title).toBe('(1) Inbox');
  });

  it('stands down while the alarm flashes', () => {
    const { doc, owner } = make();
    owner.setBase('(1) Inbox');
    expect(owner.beginFlash()).toBe('(1) Inbox');
    owner.flashWrite('⏰ Call back');
    owner.setBase('(2) Inbox');
    owner.reassert();
    expect(doc.title).toBe('⏰ Call back');
    // The flash's even ticks show the current base.
    expect(owner.base()).toBe('(2) Inbox');
  });

  it('restores the current base, not the stale one, when the flash ends', () => {
    const { doc, owner } = make();
    owner.setBase('(1) Inbox');
    owner.beginFlash();
    owner.flashWrite('⏰ Call back');
    owner.setBase('(4) Inbox');
    owner.endFlash();
    expect(doc.title).toBe('(4) Inbox');
    expect(owner.isFlashing()).toBe(false);
  });

  it('restores the tab’s own title when no updater is mounted', () => {
    const { doc, owner } = make('Original');
    owner.beginFlash();
    owner.flashWrite('⏰ Call back');
    owner.endFlash();
    expect(doc.title).toBe('Original');
  });

  it('ignores flash writes and extra ends outside a flash', () => {
    const { doc, owner } = make('Original');
    owner.flashWrite('⏰ Call back');
    owner.endFlash();
    expect(doc.title).toBe('Original');
    expect(owner.isFlashing()).toBe(false);
  });

  it('does nothing without a document', () => {
    const owner = new TitleOwner(() => null);
    owner.setBase('x');
    expect(owner.beginFlash()).toBe('x');
    owner.endFlash();
  });
});
