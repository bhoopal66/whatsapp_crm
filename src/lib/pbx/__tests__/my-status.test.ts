import { describe, expect, it } from 'vitest';

import en from '../../../../messages/en.json';
import { PRESENCE_STATUSES } from '../yeastar/events';
import {
  MY_STATUSES,
  MY_STATUS_KEY,
  isMyStatus,
  shownStatus,
  statusView,
} from '../my-status';

describe('MY_STATUSES', () => {
  it('is the PBX presence list the route accepts', () => {
    expect([...MY_STATUSES]).toEqual([...PRESENCE_STATUSES]);
    expect(isMyStatus('lunch')).toBe(true);
    expect(isMyStatus('busy')).toBe(false);
    expect(isMyStatus(null)).toBe(false);
  });

  it('has a label for every status', () => {
    for (const s of MY_STATUSES)
      expect(en.CallsPage.status[MY_STATUS_KEY[s]]).toBeTruthy();
  });

  it('reads as the dots read the status', () => {
    expect(MY_STATUSES.map(statusView)).toEqual([
      'available',
      'away',
      'away',
      'dnd',
      'away',
      'off_work',
    ]);
  });
});

describe('shownStatus', () => {
  it('shows the held status until the live view moves', () => {
    expect(shownStatus({ status: 'lunch', viewAt: undefined }, undefined)).toBe(
      'lunch'
    );
    // A choice the phone has not echoed back yet stands.
    expect(
      shownStatus({ status: 'lunch', viewAt: 'available' }, 'available')
    ).toBe('lunch');
    expect(
      shownStatus({ status: null, viewAt: undefined }, undefined)
    ).toBeNull();
  });

  it('keeps a finer status the live view agrees with', () => {
    expect(shownStatus({ status: 'lunch', viewAt: 'available' }, 'away')).toBe(
      'lunch'
    );
    expect(
      shownStatus({ status: 'business_trip', viewAt: undefined }, 'away')
    ).toBe('business_trip');
    expect(
      shownStatus({ status: 'available', viewAt: undefined }, 'available')
    ).toBe('available');
  });

  it('follows a change made elsewhere', () => {
    expect(shownStatus({ status: 'lunch', viewAt: 'away' }, 'dnd')).toBe(
      'do_not_disturb'
    );
    expect(
      shownStatus({ status: 'away', viewAt: undefined }, 'available')
    ).toBe('available');
    expect(shownStatus({ status: null, viewAt: undefined }, 'off_work')).toBe(
      'off_work'
    );
    expect(
      shownStatus({ status: 'available', viewAt: 'available' }, 'away')
    ).toBe('away');
  });

  it('ignores a call, which says nothing about the chosen status', () => {
    expect(shownStatus({ status: 'lunch', viewAt: 'away' }, 'on_call')).toBe(
      'lunch'
    );
    expect(
      shownStatus({ status: null, viewAt: undefined }, 'on_call')
    ).toBeNull();
  });
});
