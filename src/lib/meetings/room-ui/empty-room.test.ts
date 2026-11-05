import { describe, expect, it } from 'vitest';

import { emptyRoomAction } from './stage';

describe('emptyRoomAction', () => {
  it('offers the link whenever the link admits people', () => {
    for (const isOrganiser of [true, false]) {
      expect(emptyRoomAction({ openToWorkspace: true, isOrganiser })).toBe(
        'link'
      );
    }
  });

  it('offers the organiser the invite in a closed meeting', () => {
    expect(emptyRoomAction({ openToWorkspace: false, isOrganiser: true })).toBe(
      'invite'
    );
  });

  it('offers a non-organiser nothing in a closed meeting', () => {
    expect(
      emptyRoomAction({ openToWorkspace: false, isOrganiser: false })
    ).toBe('wait');
  });
});
