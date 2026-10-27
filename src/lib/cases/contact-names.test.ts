// The contact-name lookup the case inbox route adds to each row (141).
import { describe, expect, it } from 'vitest';

import { contactNames } from './contact-names';
import { ACCOUNT_ID, FakeClient } from './read-fakes';
import { CaseStoreError } from './store';

const K1 = '11111111-1111-4111-8111-111111111111';
const K2 = '22222222-2222-4222-8222-222222222222';

function db(rows: unknown[]) {
  return new FakeClient('db', [], {}, { contacts: () => ({ data: rows }) });
}

describe('contactNames', () => {
  it("maps each contact id to the contact's own name, skipping blanks", async () => {
    const d = db([
      { id: K1, name: 'Nasrullah' },
      { id: K2, name: ' ' },
    ]);
    const m = await contactNames(d.client, ACCOUNT_ID, [K1, K2]);
    expect([...m]).toEqual([[K1, 'Nasrullah']]);
  });

  it('reads once, deduplicated, confined to the account', async () => {
    const d = db([]);
    await contactNames(d.client, ACCOUNT_ID, [K1, null, K1, K2]);
    const [q] = d.queriesOf('contacts');
    expect(q.filters).toEqual([
      ['eq', 'account_id', ACCOUNT_ID],
      ['in', 'id', [K1, K2]],
    ]);
  });

  it('asks nothing when no row has a contact', async () => {
    const d = db([]);
    expect((await contactNames(d.client, ACCOUNT_ID, [null])).size).toBe(0);
    expect(d.queries).toHaveLength(0);
  });

  it('a read error is a CaseStoreError', async () => {
    const d = new FakeClient(
      'db',
      [],
      {},
      { contacts: () => ({ error: { code: '42501' } }) }
    );
    await expect(
      contactNames(d.client, ACCOUNT_ID, [K1])
    ).rejects.toBeInstanceOf(CaseStoreError);
  });
});
