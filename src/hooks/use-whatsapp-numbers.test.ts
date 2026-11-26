import { describe, expect, it } from 'vitest';

import {
  mergeMyNumberIds,
  predictNumber,
  type AccountNumber,
} from './use-whatsapp-numbers';

function num(id: string, extra: Partial<AccountNumber> = {}): AccountNumber {
  return {
    id,
    provider: 'openwa',
    label: id,
    waba_id: null,
    phone_number_id: `pn-${id}`,
    is_primary: false,
    status: 'connected',
    is_personal: false,
    user_id: null,
    access_restricted: false,
    ...extra,
  };
}

describe('mergeMyNumberIds', () => {
  it('adds the caller own personal number to the allocated ones', () => {
    expect(mergeMyNumberIds(['a', 'b'], ['p'])).toEqual(['a', 'b', 'p']);
  });
  it('does not repeat an id', () => {
    expect(mergeMyNumberIds(['a'], ['a'])).toEqual(['a']);
  });
});

describe('predictNumber and personal numbers (190)', () => {
  const company = num('company');
  const mine = num('mine', { is_personal: true, user_id: 'me' });

  it('never predicts a personal number, even when preferred', () => {
    expect(predictNumber([mine, company], 'openwa', ['mine'])?.id).toBe(
      'company'
    );
  });
  it('predicts nothing when only personal numbers exist', () => {
    expect(predictNumber([mine], 'openwa', ['mine'])).toBeNull();
  });
});
