import { describe, expect, it } from 'vitest';
import { INBOUND_PUSH_MAX_AGE_MS, shouldPushInbound } from './inbound';

const NOW = 1_800_000_000_000;
const sec = (ms: number) => String(Math.floor(ms / 1000));

describe('shouldPushInbound', () => {
  it('rings for a live message on a company number', () => {
    expect(
      shouldPushInbound({
        isPersonalNumber: false,
        messageTimestamp: sec(NOW - 10_000),
        nowMs: NOW,
      })
    ).toBe(true);
  });

  it('never rings for a personal number', () => {
    expect(
      shouldPushInbound({
        isPersonalNumber: true,
        messageTimestamp: sec(NOW),
        nowMs: NOW,
      })
    ).toBe(false);
  });

  it('rings up to the age limit and not after it', () => {
    const at = (age: number) =>
      shouldPushInbound({
        isPersonalNumber: false,
        messageTimestamp: sec(NOW - age),
        nowMs: NOW,
      });
    expect(at(INBOUND_PUSH_MAX_AGE_MS)).toBe(true);
    expect(at(INBOUND_PUSH_MAX_AGE_MS + 1000)).toBe(false);
    expect(at(24 * 60 * 60 * 1000)).toBe(false);
  });

  it('rings when the timestamp cannot be read (fail open, as before)', () => {
    for (const t of [null, undefined, '', 'abc', '0']) {
      expect(
        shouldPushInbound({
          isPersonalNumber: false,
          messageTimestamp: t,
          nowMs: NOW,
        })
      ).toBe(true);
    }
  });
});
