import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { markRoomBellsRead } from './bells';

function fakeSb(error: unknown = null) {
  const ops: unknown[][] = [];
  const q: Record<string, unknown> = {
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ error }).then(ok),
  };
  for (const m of ['update', 'eq', 'is']) {
    q[m] = (...a: unknown[]) => (ops.push([m, ...a]), q);
  }
  const from = (table: string) => (ops.push(['from', table]), q);
  return { sb: { from } as never, ops };
}

describe('markRoomBellsRead', () => {
  it("reads only this room's unread message bells", async () => {
    const { sb, ops } = fakeSb();
    await markRoomBellsRead(sb, 'room-1');
    expect(ops).toEqual([
      ['from', 'notifications'],
      ['update', { read_at: expect.any(String) }],
      ['eq', 'type', 'deal_room_message'],
      ['eq', 'meta->>room_id', 'room-1'],
      ['is', 'read_at', null],
    ]);
  });

  it('never throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sb } = fakeSb({ message: 'blip' });
    await expect(markRoomBellsRead(sb, 'room-1')).resolves.toBeUndefined();
  });

  // An unread bell silences the room (274), so showing the room must clear
  // it: after each read, and on return to the tab. No DOM here to mount it.
  it('is called by the room screen, only while it is visible', () => {
    const src = readFileSync('src/components/deal-rooms/room-view.tsx', 'utf8');
    expect(
      src.match(
        /document\.visibilityState === 'visible'\) \{\s+void markRoomBellsRead\(sb, roomId\)/g
      )
    ).toHaveLength(2);
  });
});
