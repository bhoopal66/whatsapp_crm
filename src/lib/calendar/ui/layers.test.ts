import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LAYERS,
  filterByLayers,
  itemLayer,
  layersStorageKey,
  parseLayers,
  serialiseLayers,
} from './layers';
import { aMeeting, aTask, anEvent } from './test-items';

describe('itemLayer', () => {
  it('sorts items into layers', () => {
    expect(itemLayer(anEvent())).toBe('mine');
    expect(itemLayer(anEvent({ myResponse: 'pending' }))).toBe('invitations');
    expect(itemLayer(anEvent({ myResponse: 'declined' }))).toBe('invitations');
    expect(itemLayer(anEvent({ myResponse: null }))).toBe('invitations');
    expect(itemLayer(aMeeting())).toBe('meetings');
    expect(itemLayer(aTask())).toBe('tasks');
  });
});

describe('filterByLayers', () => {
  const items = [
    anEvent(),
    anEvent({ id: 'e2', myResponse: 'accepted' }),
    aMeeting(),
    aTask(),
  ];

  it('shows everything by default', () => {
    expect(filterByLayers(items, DEFAULT_LAYERS)).toHaveLength(4);
  });

  it('hides a switched-off layer', () => {
    const out = filterByLayers(items, {
      ...DEFAULT_LAYERS,
      tasks: false,
      invitations: false,
    });
    expect(out.map((i) => i.id)).toEqual(['e1', 'm1']);
  });
});

describe('layer persistence', () => {
  it('round-trips', () => {
    const l = { ...DEFAULT_LAYERS, tasks: false, workspaceMeetings: true };
    expect(parseLayers(serialiseLayers(l))).toEqual(l);
  });

  it('falls back key by key on bad input', () => {
    expect(parseLayers(null)).toEqual(DEFAULT_LAYERS);
    expect(parseLayers('not json')).toEqual(DEFAULT_LAYERS);
    expect(parseLayers('[true]')).toEqual(DEFAULT_LAYERS);
    expect(parseLayers('{"tasks":false,"mine":"no","bogus":true}')).toEqual({
      ...DEFAULT_LAYERS,
      tasks: false,
    });
  });

  it('keys storage per viewer', () => {
    expect(layersStorageKey('u1')).not.toBe(layersStorageKey('u2'));
  });
});
