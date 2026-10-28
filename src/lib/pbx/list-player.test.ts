import { describe, expect, it } from 'vitest';

import { listPlayerOffered, nextOpenPlayer } from './list-player';

describe('listPlayerOffered', () => {
  it('offers Play on a stored recording', () => {
    expect(listPlayerOffered({ recordingState: 'fetched' })).toBe(true);
    expect(
      listPlayerOffered({ recordingState: 'fetched', recordingDeleted: false })
    ).toBe(true);
  });

  it('offers nothing where there is no audio to play', () => {
    for (const recordingState of [
      'none',
      'failed',
      'pending',
      'held',
      'erased',
      'not_stored',
      '',
    ])
      expect(listPlayerOffered({ recordingState })).toBe(false);
    // Deleted under the retention period: the row keeps 'fetched'.
    expect(
      listPlayerOffered({ recordingState: 'fetched', recordingDeleted: true })
    ).toBe(false);
  });
});

describe('nextOpenPlayer', () => {
  it('opens a row, and closes it on a second press', () => {
    expect(nextOpenPlayer(null, 'a')).toBe('a');
    expect(nextOpenPlayer('a', 'a')).toBeNull();
  });

  it('keeps one player open: opening another closes the first', () => {
    expect(nextOpenPlayer('a', 'b')).toBe('b');
  });
});
