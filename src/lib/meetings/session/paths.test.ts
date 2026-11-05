import { describe, expect, it } from 'vitest';

import { isMeetingRoomPath, meetingRoomIdFrom } from './paths';

describe('meetingRoomIdFrom', () => {
  it('reads the id from the room path, trailing slash or not', () => {
    expect(meetingRoomIdFrom('/meetings/m1/room')).toBe('m1');
    expect(meetingRoomIdFrom('/meetings/m1/room/')).toBe('m1');
    expect(isMeetingRoomPath('/meetings/m1/room')).toBe(true);
  });

  it('matches nothing else', () => {
    for (const path of [
      '/meetings',
      '/meetings/m1',
      '/meetings/room',
      '/meetings//room',
      '/meetings/m1/room/extra',
      '/x/meetings/m1/room',
      '/inbox',
    ]) {
      expect(meetingRoomIdFrom(path)).toBeNull();
      expect(isMeetingRoomPath(path)).toBe(false);
    }
  });
});
