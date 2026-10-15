import { describe, expect, it } from 'vitest';

import { EVENT_COLORS } from '../validate';
import { colorVar, paletteCss } from './colors';
import { FeedCache, feedUrl, parseFeedResponse } from './feed-cache';
import { isEditableTarget, keyAction } from './keyboard';
import { upcomingItems } from './upcoming';
import { aMeeting, aTask, anEvent } from './test-items';

describe('colours', () => {
  it('maps each colour to its variables', () => {
    expect(colorVar('green', 'solid')).toBe('var(--cal-green)');
    expect(colorVar('green', 'soft')).toBe('var(--cal-green-soft)');
    expect(colorVar(undefined, 'solid')).toBe('var(--cal-slate)');
  });

  it('declares every colour in light and dark', () => {
    const css = paletteCss('.cal-root');
    for (const c of EVENT_COLORS) {
      expect(css.match(new RegExp(`--cal-${c}:`, 'g'))).toHaveLength(2);
      expect(css.match(new RegExp(`--cal-${c}-soft:`, 'g'))).toHaveLength(2);
    }
    expect(css).toContain("html[data-mode='dark'] .cal-root");
    expect(css).not.toContain('.dark');
  });
});

describe('FeedCache', () => {
  it('serves an entry for 30 s, then drops it', () => {
    let now = 1_000;
    const cache = new FeedCache(30_000, () => now);
    cache.set('k', [anEvent()]);
    now += 29_999;
    expect(cache.get('k')).toHaveLength(1);
    now += 1;
    expect(cache.get('k')).toBeNull();
  });

  it('clears', () => {
    const cache = new FeedCache();
    cache.set('k', []);
    cache.clear();
    expect(cache.get('k')).toBeNull();
  });

  it('builds the feed URL', () => {
    expect(
      feedUrl('2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', false)
    ).toBe(
      '/api/calendar/feed?from=2026-10-01T00%3A00%3A00.000Z&to=2026-11-01T00%3A00%3A00.000Z'
    );
    expect(feedUrl('a', 'b', true)).toContain('includeWorkspaceMeetings=1');
  });

  it('reads a response defensively', () => {
    expect(parseFeedResponse({ items: [anEvent()] })).toHaveLength(1);
    expect(parseFeedResponse({ error: 'x' })).toEqual([]);
    expect(parseFeedResponse(null)).toEqual([]);
  });
});

describe('keyAction', () => {
  const k = (key: string, over = {}) =>
    keyAction({ key, inEditable: false, ...over });

  it('maps the shortcuts', () => {
    expect(k('t')).toEqual({ type: 'today' });
    expect(k('J')).toEqual({ type: 'prev' });
    expect(k('ArrowRight')).toEqual({ type: 'next' });
    expect(k('w')).toEqual({ type: 'view', view: 'week' });
    expect(k('a')).toEqual({ type: 'view', view: 'agenda' });
    expect(k('n')).toEqual({ type: 'create' });
    expect(k('/')).toEqual({ type: 'focusSearch' });
    expect(k('Escape')).toEqual({ type: 'clearSearch' });
    expect(k('q')).toBeNull();
  });

  it('ignores typing and modified keys', () => {
    expect(k('t', { inEditable: true })).toBeNull();
    expect(k('n', { metaKey: true })).toBeNull();
    expect(k('k', { ctrlKey: true })).toBeNull();
  });

  it('recognises editable targets', () => {
    expect(isEditableTarget({ tagName: 'input' })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(
      true
    );
    expect(isEditableTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('upcomingItems', () => {
  const now = Date.parse('2026-10-15T07:00:00Z');

  it('lists what is not over and starts within 7 days, soonest first', () => {
    const past = anEvent({
      id: 'past',
      start: '2026-10-14T06:00:00Z',
      end: '2026-10-14T07:00:00Z',
    });
    const ongoing = anEvent({
      id: 'on',
      start: '2026-10-15T06:30:00Z',
      end: '2026-10-15T07:30:00Z',
    });
    const soon = aMeeting({ id: 'soon' });
    const task = aTask({ id: 'task' });
    const far = anEvent({
      id: 'far',
      start: '2026-10-23T06:00:00Z',
      end: '2026-10-23T07:00:00Z',
    });
    expect(
      upcomingItems([far, task, soon, past, ongoing], now, 'Asia/Dubai').map(
        (i) => i.id
      )
    ).toEqual(['on', 'soon', 'task']);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 5 }, (_, i) => aMeeting({ id: `m${i}` }));
    expect(upcomingItems(many, now, 'UTC', 7, 3)).toHaveLength(3);
  });
});
