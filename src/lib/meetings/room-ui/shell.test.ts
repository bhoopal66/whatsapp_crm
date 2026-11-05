import { describe, expect, it } from 'vitest';

import { dockMode } from './controls';
import { fitGrid } from './grid';
import { shortcutFor, talkReleased, talkStarts } from './keys';
import { arrangeStage, tileSizes, type StageTile } from './stage';
import { duoSelfBox, stageMetrics, stripPlacementFor } from './tiles';

const cam = (id: string, isSelf = false): StageTile => ({
  key: `${id}:camera`,
  participantId: id,
  isSelf,
  kind: 'camera',
});
const screen = (id: string, isSelf = false): StageTile => ({
  ...cam(id, isSelf),
  key: `${id}:screen`,
  kind: 'screen',
});
const base = {
  mode: 'auto' as const,
  pinnedKey: null,
  activeSpeakerId: null,
  lastRemoteSpeakerId: null,
  page: 0,
};

describe('dockMode', () => {
  it('follows the measured width', () => {
    expect(dockMode(980)).toBe('full');
    expect(dockMode(979)).toBe('icons');
    expect(dockMode(620)).toBe('icons');
    expect(dockMode(619)).toBe('compact');
  });
});

describe('fitGrid side-by-side bias', () => {
  it('seats two people side by side when stacking is only a little bigger', () => {
    // Stacked 437 px wide, side by side 386: within 15%.
    expect(fitGrid(2, 780, 500)).toMatchObject({ columns: 2, rows: 1 });
  });

  it('still stacks when side by side costs too much', () => {
    expect(fitGrid(2, 500, 900).columns).toBe(1);
  });
});

describe('arrangeStage shell modes', () => {
  it('duo: two cameras, the other person large and ours floating', () => {
    const s = arrangeStage({ ...base, tiles: [cam('me', true), cam('a')] });
    expect(s).toMatchObject({
      kind: 'duo',
      main: { key: 'a:camera' },
      self: { key: 'me:camera' },
    });
  });

  it('duo is Gallery only, and never with three tiles or a pin', () => {
    const tiles = [cam('me', true), cam('a')];
    expect(arrangeStage({ ...base, tiles, mode: 'speaker' }).kind).toBe(
      'spotlight'
    );
    expect(arrangeStage({ ...base, tiles, pinnedKey: 'me:camera' }).kind).toBe(
      'spotlight'
    );
    expect(arrangeStage({ ...base, tiles: [...tiles, cam('b')] }).kind).toBe(
      'gallery'
    );
  });

  it('focus: the main tile alone, everyone else hidden', () => {
    const s = arrangeStage({
      ...base,
      mode: 'focus',
      activeSpeakerId: 'b',
      tiles: [cam('me', true), cam('a'), cam('b')],
    });
    expect(s).toMatchObject({ main: { key: 'b:camera' }, strip: [] });
    expect(
      tileSizes(
        s,
        ['me', 'a', 'b'],
        { gallery: 0, main: 700, strip: 0 },
        1,
        'me'
      )
    ).toEqual({ a: 'hidden', b: 'large' });
  });

  it('hideSelf leaves our camera out', () => {
    const s = arrangeStage({
      ...base,
      hideSelf: true,
      tiles: [cam('me', true), cam('a'), cam('b')],
    });
    expect(s.kind === 'gallery' && s.tiles.map((t) => t.key)).toEqual([
      'a:camera',
      'b:camera',
    ]);
  });

  it('hideSelf keeps our camera when alone or while we share', () => {
    const alone = arrangeStage({
      ...base,
      hideSelf: true,
      tiles: [cam('me', true)],
    });
    expect(alone.kind === 'gallery' && alone.tiles).toHaveLength(1);
    const sharing = arrangeStage({
      ...base,
      hideSelf: true,
      tiles: [cam('me', true), screen('me', true), cam('a')],
    });
    expect(
      sharing.kind === 'spotlight' && sharing.strip.map((t) => t.key)
    ).toEqual(['me:camera', 'me:screen']);
  });

  it('our own screen is the main tile only when nobody else is here', () => {
    const others = arrangeStage({
      ...base,
      tiles: [cam('me', true), screen('me', true), cam('a')],
    });
    expect(others).toMatchObject({ main: { key: 'a:camera' } });
    const alone = arrangeStage({
      ...base,
      tiles: [cam('me', true), screen('me', true)],
    });
    expect(alone).toMatchObject({ main: { key: 'me:screen' } });
  });
});

describe('stage boxes', () => {
  const spot = arrangeStage({
    ...base,
    tiles: [cam('me', true), screen('a'), cam('a')],
  });

  it('puts the strip on the right of a wide stage, else below', () => {
    expect(stripPlacementFor(1200, 600)).toBe('right');
    expect(stripPlacementFor(899, 400)).toBe('bottom');
    expect(stripPlacementFor(1000, 700)).toBe('bottom');
  });

  it('a right-hand strip takes width, not height', () => {
    const m = stageMetrics(spot, 1200, 600);
    expect(m.stripPlacement).toBe('right');
    expect(m.mainHeight).toBe(600);
    expect(m.mainWidth).toBe(1200 - m.stripWidth - 8);
  });

  it('sizes the duo corner tile at 22% of the stage, 160 px at least', () => {
    expect(duoSelfBox(1000).width).toBe(220);
    expect(duoSelfBox(390).width).toBe(160);
  });
});

describe('keyboard', () => {
  it('adds F and ?', () => {
    expect(shortcutFor({ key: 'f' }, null)).toBe('fullscreen');
    expect(shortcutFor({ key: '?' }, null)).toBe('shortcuts');
  });

  const muted = { micOn: false, held: false };

  it('Space talks only while muted, once per hold', () => {
    expect(talkStarts({ key: ' ' }, { tagName: 'DIV' }, muted)).toBe(true);
    expect(talkStarts({ key: ' ' }, null, { micOn: true, held: false })).toBe(
      false
    );
    expect(talkStarts({ key: ' ' }, null, { micOn: false, held: true })).toBe(
      false
    );
    expect(talkStarts({ key: ' ', repeat: true }, null, muted)).toBe(false);
  });

  it('Space stays out of fields and focused controls', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'BUTTON', 'A']) {
      expect(talkStarts({ key: ' ' }, { tagName }, muted)).toBe(false);
    }
    expect(talkStarts({ key: ' ' }, { isContentEditable: true }, muted)).toBe(
      false
    );
  });

  it('a keyup, blur or tab switch restores; nothing else does', () => {
    expect(talkReleased(' ', true)).toBe(true);
    expect(talkReleased(null, true)).toBe(true);
    expect(talkReleased('m', true)).toBe(false);
    expect(talkReleased(' ', false)).toBe(false);
  });
});
