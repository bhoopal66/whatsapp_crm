import { describe, expect, it } from 'vitest';

import {
  chatBodyToSend,
  groupChat,
  isNearBottom,
  safeHref,
  splitLinks,
  unreadCount,
} from './chat';
import { fitGrid, paginate, tileAspect } from './grid';
import { chatKeyAction, clampPanelWidth, shortcutFor } from './keys';
import {
  avatarColor,
  AVATAR_COLORS,
  formatElapsed,
  handRaisedAtOf,
  initials,
  orderPeople,
  qualityBars,
  reactionOffset,
} from './people';
import {
  arrangeStage,
  sizeForHeight,
  tileSizes,
  type StageTile,
} from './stage';

const cam = (id: string, isSelf = false): StageTile => ({
  key: `${id}:camera`,
  participantId: id,
  isSelf,
  kind: 'camera',
});
const scr = (id: string, isSelf = false): StageTile => ({
  key: `${id}:screen`,
  participantId: id,
  isSelf,
  kind: 'screen',
});
const base = {
  mode: 'auto' as const,
  pinnedKey: null,
  activeSpeakerId: null,
  lastRemoteSpeakerId: null,
  page: 0,
};

describe('fitGrid', () => {
  it('one tile fills the height of a wide stage at 16:9', () => {
    const f = fitGrid(1, 1600, 900, 0);
    expect(f).toMatchObject({
      columns: 1,
      rows: 1,
      tileWidth: 1600,
      tileHeight: 900,
    });
  });
  it('two tiles side by side on a wide stage, stacked on a tall one', () => {
    expect(fitGrid(2, 1600, 600).columns).toBe(2);
    expect(fitGrid(2, 400, 900).columns).toBe(1);
  });
  it('four tiles 2×2, nine 3×3, sixteen 4×4 on a 16:9 stage', () => {
    expect(fitGrid(4, 1600, 900)).toMatchObject({ columns: 2, rows: 2 });
    expect(fitGrid(9, 1600, 900)).toMatchObject({ columns: 3, rows: 3 });
    expect(fitGrid(16, 1600, 900)).toMatchObject({ columns: 4, rows: 4 });
  });
  it('tiles never overflow the stage', () => {
    for (let n = 1; n <= 16; n++) {
      const f = fitGrid(n, 1280, 640, 8);
      expect(f.columns * f.tileWidth + (f.columns - 1) * 8).toBeLessThanOrEqual(
        1280
      );
      expect(f.rows * f.tileHeight + (f.rows - 1) * 8).toBeLessThanOrEqual(640);
      expect(f.columns * f.rows).toBeGreaterThanOrEqual(n);
    }
  });
  it('survives an unmeasured stage', () => {
    expect(fitGrid(4, 0, 0)).toMatchObject({
      columns: 2,
      rows: 2,
      tileWidth: 0,
    });
  });
  it('portrait phones get 3:4 tiles', () => {
    expect(tileAspect(390, 800)).toBeCloseTo(0.75);
    expect(tileAspect(1280, 720)).toBeCloseTo(16 / 9);
  });
});

describe('paginate', () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  it('pages of 16 and clamps the page', () => {
    expect(paginate(items, 0)).toMatchObject({ pageCount: 2, page: 0 });
    expect(paginate(items, 1).items).toEqual([16, 17, 18, 19]);
    expect(paginate(items, 9).page).toBe(1);
    expect(paginate([], 3)).toMatchObject({ page: 0, pageCount: 1, items: [] });
  });
});

describe('arrangeStage', () => {
  const tiles = [cam('me', true), cam('a'), cam('b')];
  it('Auto is a gallery', () => {
    const s = arrangeStage({ ...base, tiles });
    expect(s.kind).toBe('gallery');
  });
  it('a share takes the stage, someone else ahead of our own', () => {
    const s = arrangeStage({
      ...base,
      tiles: [cam('me', true), scr('me', true), cam('a'), scr('a')],
    });
    expect(s.kind === 'spotlight' && s.main.key).toBe('a:screen');
    expect(s.kind === 'spotlight' && s.strip.map((t) => t.key)).toEqual([
      'me:camera',
      'me:screen',
      'a:camera',
    ]);
  });
  it('a pin overrides the share and the speaker', () => {
    const s = arrangeStage({
      ...base,
      mode: 'speaker',
      activeSpeakerId: 'a',
      pinnedKey: 'b:camera',
      tiles: [...tiles, scr('a')],
    });
    expect(s.kind === 'spotlight' && [s.reason, s.main.key]).toEqual([
      'pinned',
      'b:camera',
    ]);
  });
  it('a stale pin is ignored', () => {
    expect(
      arrangeStage({ ...base, pinnedKey: 'gone:camera', tiles }).kind
    ).toBe('gallery');
  });
  it('Speaker shows the active remote speaker, and keeps the last one while we talk', () => {
    const s1 = arrangeStage({
      ...base,
      mode: 'speaker',
      activeSpeakerId: 'b',
      tiles,
    });
    expect(s1.kind === 'spotlight' && s1.main.key).toBe('b:camera');
    const s2 = arrangeStage({
      ...base,
      mode: 'speaker',
      activeSpeakerId: 'me',
      lastRemoteSpeakerId: 'b',
      tiles,
    });
    expect(s2.kind === 'spotlight' && s2.main.key).toBe('b:camera');
    const s3 = arrangeStage({ ...base, mode: 'speaker', tiles });
    expect(s3.kind === 'spotlight' && s3.main.key).toBe('a:camera');
  });
  it('Speaker alone in the room is a gallery of one', () => {
    expect(
      arrangeStage({ ...base, mode: 'speaker', tiles: [cam('me', true)] }).kind
    ).toBe('gallery');
  });
  it('paginates past 16', () => {
    const many = Array.from({ length: 20 }, (_, i) => cam(`p${i}`, i === 0));
    const s = arrangeStage({ ...base, tiles: many, page: 1 });
    expect(s.kind === 'gallery' && [s.tiles.length, s.pageCount]).toEqual([
      4, 2,
    ]);
  });
});

describe('tileSizes', () => {
  it('maps drawn heights to layers and hides what is off the page', () => {
    const many = Array.from({ length: 18 }, (_, i) => cam(`p${i}`, i === 0));
    const s = arrangeStage({ ...base, tiles: many });
    const sizes = tileSizes(
      s,
      many.map((t) => t.participantId),
      { gallery: 120, main: 0, strip: 0 },
      1,
      'p0'
    );
    expect(sizes.p1).toBe('small');
    expect(sizes.p17).toBe('hidden');
    expect('p0' in sizes).toBe(false);
  });
  it('spotlight: main large, strip small, a sharer by their camera', () => {
    const s = arrangeStage({
      ...base,
      tiles: [cam('me', true), cam('a'), scr('a'), cam('b')],
    });
    expect(
      tileSizes(
        s,
        ['me', 'a', 'b'],
        { gallery: 0, main: 700, strip: 110 },
        1,
        'me'
      )
    ).toEqual({ a: 'small', b: 'small' });
    const p = arrangeStage({
      ...base,
      pinnedKey: 'b:camera',
      tiles: [cam('me', true), cam('a'), cam('b')],
    });
    expect(
      tileSizes(
        p,
        ['me', 'a', 'b'],
        { gallery: 0, main: 700, strip: 200 },
        1,
        'me'
      )
    ).toEqual({ a: 'medium', b: 'large' });
  });
  it('counts device pixels', () => {
    expect(sizeForHeight(200, 2)).toBe('large');
    expect(sizeForHeight(200, 1)).toBe('medium');
    expect(sizeForHeight(100)).toBe('small');
  });
});

describe('people', () => {
  it('initials', () => {
    expect(initials('  ada  king lovelace ')).toBe('AL');
    expect(initials('김민준')).toBe('김');
    expect(initials('')).toBe('');
  });
  it('one stable colour per id', () => {
    expect(avatarColor('u-1')).toBe(avatarColor('u-1'));
    const seen = new Set(
      Array.from({ length: 50 }, (_, i) => avatarColor(`user-${i}`))
    );
    expect(seen.size).toBeGreaterThan(3);
    expect(AVATAR_COLORS).toContain(avatarColor('x'));
  });
  it('hands first by time, then self, then name', () => {
    const p = (
      id: string,
      name: string,
      handRaisedAt: string | null = null,
      isSelf = false
    ) => ({ id, name, handRaisedAt, isSelf });
    const out = orderPeople([
      p('1', 'Zed'),
      p('2', 'Amy'),
      p('3', 'Bo', '2026-01-01T00:00:02Z'),
      p('4', 'Me', null, true),
      p('5', 'Cy', '2026-01-01T00:00:01Z'),
    ]);
    expect(out.map((x) => x.id)).toEqual(['5', '3', '4', '2', '1']);
  });
  it('reads hand_raised_at defensively', () => {
    expect(handRaisedAtOf({ hand_raised_at: '2026-01-01T00:00:00Z' })).toBe(
      '2026-01-01T00:00:00Z'
    );
    expect(handRaisedAtOf({})).toBeNull();
    expect(handRaisedAtOf({ hand_raised_at: 5 })).toBeNull();
  });
  it('quality bars, timer, reaction offsets', () => {
    expect([
      qualityBars('good'),
      qualityBars('fair'),
      qualityBars('poor'),
      qualityBars('unknown'),
    ]).toEqual([3, 2, 1, 0]);
    expect(formatElapsed(65_000)).toBe('1:05');
    expect(formatElapsed(3_725_000)).toBe('1:02:05');
    expect(formatElapsed(-5)).toBe('0:00');
    const o = reactionOffset('abc');
    expect(o).toBeGreaterThanOrEqual(10);
    expect(o).toBeLessThanOrEqual(85);
  });
});

describe('chat', () => {
  const msg = (id: string, userId: string, createdAt: string, body = 'x') => ({
    id,
    userId,
    createdAt,
    body,
  });
  it('groups by author within five minutes', () => {
    const g = groupChat([
      msg('1', 'a', '2026-01-01T10:00:00Z'),
      msg('2', 'a', '2026-01-01T10:04:00Z'),
      msg('3', 'a', '2026-01-01T10:10:00Z'),
      msg('4', 'b', '2026-01-01T10:10:30Z'),
    ]);
    expect(g.map((x) => x.messages.map((m) => m.id))).toEqual([
      ['1', '2'],
      ['3'],
      ['4'],
    ]);
  });
  it('links http(s) and www, trims trailing punctuation', () => {
    expect(splitLinks('see https://example.com/a?b=1, ok')).toEqual([
      { type: 'text', text: 'see ' },
      {
        type: 'link',
        text: 'https://example.com/a?b=1',
        href: 'https://example.com/a?b=1',
      },
      { type: 'text', text: ', ok' },
    ]);
    expect(splitLinks('(www.taamul.ae)')[1]).toEqual({
      type: 'link',
      text: 'www.taamul.ae',
      href: 'https://www.taamul.ae/',
    });
  });
  it('never links javascript:, data: or other schemes', () => {
    for (const s of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<b>x</b>',
      'vbscript:x',
      'file:///etc/passwd',
    ]) {
      const parts = splitLinks(`click ${s} now`);
      expect(parts.every((p) => p.type === 'text')).toBe(true);
      expect(parts.map((p) => p.text).join('')).toBe(`click ${s} now`);
    }
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('https://ok.example')).toBe('https://ok.example/');
  });
  it('keeps text intact around links', () => {
    const t = 'a https://x.io b www.y.io. c';
    expect(
      splitLinks(t)
        .map((p) => p.text)
        .join('')
    ).toBe(t);
  });
  it('unread: others only, after the last seen', () => {
    const list = [
      msg('1', 'a', '2026-01-01T10:00:00Z'),
      msg('2', 'me', '2026-01-01T10:01:00Z'),
      msg('3', 'b', '2026-01-01T10:02:00Z'),
    ];
    expect(unreadCount(list, null, 'me')).toBe(2);
    expect(unreadCount(list, '2026-01-01T10:00:00Z', 'me')).toBe(1);
  });
  it('autoscroll threshold and body limits', () => {
    expect(isNearBottom(900, 1500, 560)).toBe(true);
    expect(isNearBottom(100, 1500, 560)).toBe(false);
    expect(chatBodyToSend('  hi  ')).toBe('hi');
    expect(chatBodyToSend('   ')).toBeNull();
    expect(chatBodyToSend('x'.repeat(2001))).toBeNull();
    expect(chatBodyToSend('x'.repeat(2000))).toHaveLength(2000);
  });
});

describe('keys', () => {
  const body = { tagName: 'BODY' };
  it('maps letters, case-insensitively', () => {
    expect(
      ['m', 'V', 's', 'h', 'c', 'p', 'Escape'].map((key) =>
        shortcutFor({ key }, body)
      )
    ).toEqual([
      'mic',
      'camera',
      'share',
      'hand',
      'chat',
      'people',
      'closePanel',
    ]);
    expect(shortcutFor({ key: 'x' }, body)).toBeNull();
  });
  it('stays out of the way while typing, with modifiers, repeats or IME', () => {
    expect(shortcutFor({ key: 'm' }, { tagName: 'TEXTAREA' })).toBeNull();
    expect(shortcutFor({ key: 'm' }, { tagName: 'input' })).toBeNull();
    expect(
      shortcutFor({ key: 'm' }, { tagName: 'DIV', isContentEditable: true })
    ).toBeNull();
    expect(shortcutFor({ key: 'c', ctrlKey: true }, body)).toBeNull();
    expect(shortcutFor({ key: 'c', metaKey: true }, body)).toBeNull();
    expect(shortcutFor({ key: 'm', repeat: true }, body)).toBeNull();
    expect(shortcutFor({ key: 'm', isComposing: true }, body)).toBeNull();
    expect(shortcutFor({ key: 'm', defaultPrevented: true }, body)).toBeNull();
  });
  it('Enter sends, Shift+Enter and IME Enter do not', () => {
    expect(chatKeyAction({ key: 'Enter' })).toBe('send');
    expect(chatKeyAction({ key: 'Enter', shiftKey: true })).toBeNull();
    expect(chatKeyAction({ key: 'Enter', isComposing: true })).toBeNull();
    expect(chatKeyAction({ key: 'a' })).toBeNull();
  });
  it('clamps the panel width', () => {
    expect([
      clampPanelWidth(100),
      clampPanelWidth(400.4),
      clampPanelWidth(900),
    ]).toEqual([280, 400, 520]);
  });
});
