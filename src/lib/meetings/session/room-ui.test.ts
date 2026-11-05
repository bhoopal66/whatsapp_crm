import { describe, expect, it, vi } from 'vitest';

import { PANEL_DEFAULT_WIDTH } from '@/lib/meetings/room-ui/panels';

import { createRoomUi } from './room-ui';

describe('createRoomUi', () => {
  it('starts on the defaults the room had', () => {
    expect(createRoomUi().getSnapshot()).toEqual({
      layout: 'auto',
      pinnedKey: null,
      page: 0,
      panel: null,
      panelWidth: PANEL_DEFAULT_WIDTH,
      chatSeenAt: null,
    });
  });

  it('keeps every field and tells subscribers', () => {
    const ui = createRoomUi();
    const fn = vi.fn();
    ui.subscribe(fn);
    ui.setLayout('speaker');
    ui.setPinnedKey('p1:camera');
    ui.setPage(2);
    ui.setPanel('chat');
    ui.setPanelWidth(400);
    ui.setChatSeenAt('2026-11-05T10:00:00Z');
    expect(ui.getSnapshot()).toEqual({
      layout: 'speaker',
      pinnedKey: 'p1:camera',
      page: 2,
      panel: 'chat',
      panelWidth: 400,
      chatSeenAt: '2026-11-05T10:00:00Z',
    });
    expect(fn).toHaveBeenCalledTimes(6);
  });

  it('keeps the snapshot identical when nothing changed', () => {
    const ui = createRoomUi();
    const fn = vi.fn();
    ui.subscribe(fn);
    const before = ui.getSnapshot();
    ui.setPage(0);
    expect(ui.getSnapshot()).toBe(before);
    expect(fn).not.toHaveBeenCalled();
  });
});
