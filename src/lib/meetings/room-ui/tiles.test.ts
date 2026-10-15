import { describe, expect, it } from 'vitest';

import { arrangeStage, type StageTile } from './stage';
import {
  buildStageTiles,
  nextRemoteSpeaker,
  pipTarget,
  stageMetrics,
  STAGE_GAP,
  stripTileHeight,
  visibleTiles,
} from './tiles';

const row = (id: string, ...kinds: ('audio' | 'video' | 'screen')[]) => ({
  id,
  tracks: kinds.map((kind) => ({ kind })),
});

const cam = (id: string, isSelf = false): StageTile => ({
  key: `${id}:camera`,
  participantId: id,
  isSelf,
  kind: 'camera',
});

describe('buildStageTiles', () => {
  it('puts ourselves first even before our row arrives', () => {
    const tiles = buildStageTiles({
      selfId: 'me',
      participants: [row('b', 'video'), row('a', 'video')],
      selfSharing: false,
      receivedScreens: new Set(),
    });
    expect(tiles.map((t) => t.key)).toEqual([
      'me:camera',
      'b:camera',
      'a:camera',
    ]);
    expect(tiles[0].isSelf).toBe(true);
  });

  it('does not list our own row twice', () => {
    const tiles = buildStageTiles({
      selfId: 'me',
      participants: [row('a'), row('me')],
      selfSharing: true,
      receivedScreens: new Set(),
    });
    expect(tiles.map((t) => t.key)).toEqual([
      'me:camera',
      'me:screen',
      'a:camera',
    ]);
  });

  it('adds a remote screen only once it is both published and received', () => {
    const base = {
      selfId: 'me',
      selfSharing: false,
    };
    const published = buildStageTiles({
      ...base,
      participants: [row('a', 'screen')],
      receivedScreens: new Set(),
    });
    expect(published.some((t) => t.kind === 'screen')).toBe(false);
    const received = buildStageTiles({
      ...base,
      participants: [row('a', 'video')],
      receivedScreens: new Set(['a']),
    });
    expect(received.some((t) => t.kind === 'screen')).toBe(false);
    const both = buildStageTiles({
      ...base,
      participants: [row('a', 'screen')],
      receivedScreens: new Set(['a']),
    });
    expect(both.map((t) => t.key)).toEqual([
      'me:camera',
      'a:camera',
      'a:screen',
    ]);
  });

  it('draws nothing of ours before we have an id', () => {
    const tiles = buildStageTiles({
      selfId: null,
      participants: [row('a')],
      selfSharing: false,
      receivedScreens: new Set(),
    });
    expect(tiles.map((t) => t.key)).toEqual(['a:camera']);
  });
});

describe('nextRemoteSpeaker', () => {
  it('follows a remote speaker and keeps it while we talk', () => {
    expect(nextRemoteSpeaker(null, 'a', 'me')).toBe('a');
    expect(nextRemoteSpeaker('a', 'me', 'me')).toBe('a');
    expect(nextRemoteSpeaker('a', null, 'me')).toBe('a');
    expect(nextRemoteSpeaker('a', 'b', 'me')).toBe('b');
  });
});

describe('stageMetrics', () => {
  it('fits the gallery into the stage', () => {
    const arr = arrangeStage({
      tiles: [cam('me', true), cam('a')],
      mode: 'auto',
      pinnedKey: null,
      activeSpeakerId: null,
      lastRemoteSpeakerId: null,
      page: 0,
    });
    const m = stageMetrics(arr, 1000, 400);
    expect(m.grid?.columns).toBe(2);
    expect(m.heights.gallery).toBe(m.grid?.tileHeight);
    expect(m.heights.gallery).toBeGreaterThan(0);
    expect(m.stripHeight).toBe(0);
  });

  it('gives the spotlight what the strip leaves', () => {
    const arr = arrangeStage({
      tiles: [cam('me', true), cam('a')],
      mode: 'speaker',
      pinnedKey: null,
      activeSpeakerId: 'a',
      lastRemoteSpeakerId: null,
      page: 0,
    });
    const m = stageMetrics(arr, 1000, 700);
    expect(m.stripHeight).toBe(112);
    expect(m.mainHeight).toBe(700 - 112 - STAGE_GAP);
    expect(m.heights).toEqual({ gallery: 0, main: m.mainHeight, strip: 112 });
  });

  it('uses the whole height when the spotlight has no strip', () => {
    const arr = arrangeStage({
      tiles: [cam('me', true)],
      mode: 'auto',
      pinnedKey: 'me:camera',
      activeSpeakerId: null,
      lastRemoteSpeakerId: null,
      page: 0,
    });
    const m = stageMetrics(arr, 1000, 700);
    expect(m.stripHeight).toBe(0);
    expect(m.mainHeight).toBe(700);
  });

  it('shrinks the strip on a phone', () => {
    expect(stripTileHeight(640)).toBe(72);
    expect(stripTileHeight(641)).toBe(112);
  });
});

describe('pipTarget', () => {
  const tiles = [cam('me', true), cam('a'), cam('b')];
  const gallery = arrangeStage({
    tiles,
    mode: 'auto',
    pinnedKey: null,
    activeSpeakerId: null,
    lastRemoteSpeakerId: null,
    page: 0,
  });

  it('takes the spotlight main tile', () => {
    const arr = arrangeStage({
      tiles,
      mode: 'auto',
      pinnedKey: 'b:camera',
      activeSpeakerId: 'a',
      lastRemoteSpeakerId: null,
      page: 0,
    });
    expect(pipTarget(arr, 'a', null)?.key).toBe('b:camera');
  });

  it('never takes our own pinned camera', () => {
    const arr = arrangeStage({
      tiles,
      mode: 'auto',
      pinnedKey: 'me:camera',
      activeSpeakerId: 'b',
      lastRemoteSpeakerId: null,
      page: 0,
    });
    expect(pipTarget(arr, 'b', null)?.key).toBe('b:camera');
  });

  it('follows the speaker, then the last speaker, then the first remote', () => {
    expect(pipTarget(gallery, 'b', null)?.key).toBe('b:camera');
    expect(pipTarget(gallery, 'me', 'b')?.key).toBe('b:camera');
    expect(pipTarget(gallery, null, null)?.key).toBe('a:camera');
  });

  it('ignores a speaker on another gallery page', () => {
    const paged = arrangeStage({
      tiles,
      mode: 'auto',
      pinnedKey: null,
      activeSpeakerId: null,
      lastRemoteSpeakerId: null,
      page: 0,
      perPage: 2,
    });
    expect(visibleTiles(paged).map((t) => t.key)).toEqual([
      'me:camera',
      'a:camera',
    ]);
    expect(pipTarget(paged, 'b', null)?.key).toBe('a:camera');
  });

  it('is null alone in the room', () => {
    const alone = arrangeStage({
      tiles: [cam('me', true)],
      mode: 'auto',
      pinnedKey: null,
      activeSpeakerId: null,
      lastRemoteSpeakerId: null,
      page: 0,
    });
    expect(pipTarget(alone, 'me', null)).toBeNull();
  });
});
