import { describe, expect, it } from 'vitest';

import type { AccountNumber } from '@/hooks/use-whatsapp-numbers';

import { predictSendChannels } from './predict-send-channels';

function num(
  id: string,
  provider: 'whapi' | 'meta',
  is_primary = false
): AccountNumber {
  return {
    id,
    provider,
    label: id,
    waba_id: null,
    phone_number_id: `pn-${id}`,
    is_primary,
    status: 'connected',
  };
}

const NONE = { pin: null, home: null };

describe('predictSendChannels', () => {
  it('predicts nothing with no numbers', () => {
    expect(predictSendChannels([], NONE, null)).toEqual({
      messageChannel: null,
      templateChannel: null,
    });
  });

  it('splits by kind: message on Whapi, template on Meta', () => {
    const list = [num('meta', 'meta', true), num('w1', 'whapi')];
    const p = predictSendChannels(list, NONE, null);
    expect(p.messageChannel?.id).toBe('w1');
    expect(p.templateChannel?.id).toBe('meta');
  });

  it('falls back to the primary number when a kind is not connected', () => {
    const list = [num('w1', 'whapi'), num('w2', 'whapi', true)];
    const p = predictSendChannels(list, NONE, null);
    expect(p.templateChannel?.id).toBe('w2');
  });

  it('falls back to the first number when none is primary', () => {
    const list = [num('w1', 'whapi'), num('w2', 'whapi')];
    expect(predictSendChannels(list, NONE, null).templateChannel?.id).toBe(
      'w1'
    );
  });

  it("prefers the thread's own number, then one I am allocated to", () => {
    const list = [
      num('w1', 'whapi', true),
      num('w2', 'whapi'),
      num('w3', 'whapi'),
    ];
    expect(
      predictSendChannels(list, { pin: null, home: 'w3' }, ['w2'])
        .messageChannel?.id
    ).toBe('w3');
    expect(
      predictSendChannels(list, { pin: null, home: null }, ['w2'])
        .messageChannel?.id
    ).toBe('w2');
    expect(
      predictSendChannels(list, { pin: null, home: 'gone' }, null)
        .messageChannel?.id
    ).toBe('w1');
  });

  it('a pin wins for its own kind but not for the other connected kind', () => {
    const list = [
      num('w1', 'whapi', true),
      num('w2', 'whapi'),
      num('m', 'meta'),
    ];
    const p = predictSendChannels(list, { pin: 'w2', home: 'w1' }, null);
    expect(p.messageChannel?.id).toBe('w2');
    expect(p.templateChannel?.id).toBe('m');
  });

  it('a pin wins for a kind that is not connected at all', () => {
    const list = [num('w1', 'whapi', true), num('w2', 'whapi')];
    const p = predictSendChannels(list, { pin: 'w2', home: null }, null);
    expect(p.templateChannel?.id).toBe('w2');
  });

  it('ignores a pin to a number that is no longer listed', () => {
    const list = [num('w1', 'whapi', true), num('m', 'meta')];
    const p = predictSendChannels(list, { pin: 'gone', home: null }, null);
    expect(p.messageChannel?.id).toBe('w1');
    expect(p.templateChannel?.id).toBe('m');
  });
});
