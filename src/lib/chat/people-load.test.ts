import { describe, expect, it, vi } from 'vitest';

import {
  loadPeopleWithRetries,
  PEOPLE_RETRY_DELAYS_MS,
  unknownPersonName,
} from './people-load';

describe('loadPeopleWithRetries', () => {
  it('reads once when the first read works', async () => {
    const read = vi.fn().mockResolvedValue(['Suhan Khan']);
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(loadPeopleWithRetries(read, wait)).resolves.toEqual([
      'Suhan Khan',
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('recovers from a failed first read within a second', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue(['Suhan Khan']);
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(loadPeopleWithRetries(read, wait)).resolves.toEqual([
      'Suhan Khan',
    ]);
    expect(wait.mock.calls).toEqual([[1_000]]);
  });

  it('gives up with the error after the last retry', async () => {
    const read = vi.fn().mockRejectedValue(new Error('503'));
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(loadPeopleWithRetries(read, wait)).rejects.toThrow('503');
    expect(read).toHaveBeenCalledTimes(PEOPLE_RETRY_DELAYS_MS.length + 1);
  });

  it('finishes retrying before the next minute refresh', () => {
    const total = PEOPLE_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(60_000);
  });
});

describe('unknownPersonName', () => {
  it('is blank while the list is on its way', () => {
    expect(unknownPersonName({ loaded: false, failed: false }, 'Unknown')).toBe(
      ''
    );
  });

  it('says so once the list has answered without the person', () => {
    expect(unknownPersonName({ loaded: true, failed: false }, 'Unknown')).toBe(
      'Unknown'
    );
  });

  it('says so when the list could not be read at all', () => {
    expect(unknownPersonName({ loaded: false, failed: true }, 'Unknown')).toBe(
      'Unknown'
    );
  });
});
