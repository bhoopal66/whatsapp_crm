import { describe, it, expect } from 'vitest';

import { predictSendingNumber } from './sending-number';

const n = (
  id: string,
  provider: 'whapi' | 'meta',
  is_primary = false,
  status = 'connected'
) => ({ id, provider, is_primary, status });

const whapiA = n('whapi-a', 'whapi');
const whapiB = n('whapi-b', 'whapi', true, 'disconnected');
const meta = n('meta', 'meta');
const numbers = [meta, whapiA, whapiB];

describe('predictSendingNumber', () => {
  it("a person's pin wins over the chat's number", () => {
    expect(
      predictSendingNumber(numbers, {
        send_channel_id: 'meta',
        channel_id: 'whapi-a',
      })
    ).toBe(meta);
  });

  it("follows the customer: the chat's own number when not pinned", () => {
    expect(
      predictSendingNumber(numbers, {
        send_channel_id: null,
        channel_id: 'whapi-a',
      })
    ).toBe(whapiA);
  });

  it('a pin to a number that no longer exists falls through', () => {
    expect(
      predictSendingNumber(numbers, {
        send_channel_id: 'deleted',
        channel_id: 'whapi-a',
      })
    ).toBe(whapiA);
  });

  it('a chat with no number falls back to the default number', () => {
    expect(predictSendingNumber(numbers, {})).toBe(whapiB);
  });

  it('then to a Whapi number rather than the oldest (Meta) one', () => {
    const noDefault = [meta, whapiA];
    expect(predictSendingNumber(noDefault, { channel_id: null })).toBe(whapiA);
  });

  it('then to the oldest', () => {
    expect(predictSendingNumber([meta], {})).toBe(meta);
  });

  it('knows nothing without numbers', () => {
    expect(predictSendingNumber([], { channel_id: 'whapi-a' })).toBeNull();
  });

  it('reports the disconnected number the reply would use', () => {
    // The Settings screen and the health monitor keep `status` current;
    // the inbox warns off it.
    expect(
      predictSendingNumber(numbers, { channel_id: 'whapi-b' })?.status
    ).toBe('disconnected');
  });
});
