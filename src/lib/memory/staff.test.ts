// addStaffMemory (modules 019b + 019c): tokenise with the vault first, then a verified put with a freshly minted origin.
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { VaultKind } from '@/lib/vault/crypto';
import type { TokenVault } from '@/lib/vault/tokenize';
import type { VaultSubject } from '@/lib/vault/types';
import { addStaffMemory } from './staff';
import { MemoryStore, type MemoryScope, type PutResult } from './store';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const CONTACT: MemoryScope = {
  type: 'contact',
  id: '44444444-4444-4444-8444-444444444444',
};
const CASE: MemoryScope = {
  type: 'case',
  id: '66666666-6666-4666-8666-666666666666',
};
const WORKSPACE: MemoryScope = { type: 'workspace', id: ACCOUNT };
const TEXT =
  'EID 784-1990-1234567-1, IBAN AE07 0331 2345 6789 0123 456, call +971 50 123 4567';
const OK: PutResult = {
  ok: true,
  id: 'item-1',
  deduped: false,
  evicted: 0,
  trust: 'verified',
  importance: 3,
};

class FakeVault implements TokenVault {
  readonly puts: {
    workspace: string;
    kind: VaultKind;
    value: string;
    subject: VaultSubject;
    actor: string;
  }[] = [];
  constructor(private readonly failAt = 0) {}
  async put(
    workspace: string,
    kind: VaultKind,
    value: string,
    subject: VaultSubject,
    actor: string
  ) {
    if (this.puts.length + 1 === this.failAt)
      throw new Error(`db down ${value}`);
    this.puts.push({ workspace, kind, value, subject, actor });
    const token = `vlt_${'ghjkmnpqrstvwxyz'[this.puts.length]!.repeat(26)}`;
    return { token, deduped: false };
  }
}

function memory() {
  const put = vi.fn<MemoryStore['put']>(async () => OK);
  return { put };
}

describe('addStaffMemory', () => {
  it('with a vault and a contact or case scope, the vault gets the values and put gets only placeholders', async () => {
    for (const scope of [CONTACT, CASE]) {
      const vault = new FakeVault();
      const m = memory();
      expect(
        await addStaffMemory(
          { memory: m, vault },
          { accountId: ACCOUNT, userId: USER, scope, content: TEXT }
        )
      ).toBe(OK);
      expect(vault.puts.map((p) => p.kind)).toEqual(['EID', 'IBAN', 'PHONE']);
      expect(vault.puts.map((p) => p.value).join(' ')).toMatch(/784.*1990/);
      for (const p of vault.puts) {
        expect(p).toMatchObject({
          workspace: ACCOUNT,
          subject: { type: scope.type, id: scope.id },
          actor: USER,
        });
      }
      expect(m.put).toHaveBeenCalledTimes(1);
      const [account, sc, content] = m.put.mock.calls[0]!;
      expect([account, sc]).toEqual([ACCOUNT, scope]);
      expect(content).toMatch(/\[EID:vlt_[a-z]{26}\]/);
      expect(content).toMatch(/\[IBAN:vlt_[a-z]{26}\]/);
      expect(content).toMatch(/\[PHONE:vlt_[a-z]{26}\]/);
      expect(content).not.toMatch(/\d/);
    }
  });

  it('a vault put that throws stores nothing and answers the fixed TOKENIZE_FAILED code', async () => {
    const vault = new FakeVault(2);
    const m = memory();
    const r = await addStaffMemory(
      { memory: m, vault },
      { accountId: ACCOUNT, userId: USER, scope: CONTACT, content: TEXT }
    );
    expect(r).toEqual({ ok: false, refused: 'TOKENIZE_FAILED' });
    expect(m.put).not.toHaveBeenCalled();
  });

  it('with no vault, put gets the raw text (put redacts it)', async () => {
    const m = memory();
    await addStaffMemory(
      { memory: m, vault: null },
      { accountId: ACCOUNT, userId: USER, scope: CONTACT, content: TEXT }
    );
    expect(m.put.mock.calls[0]![2]).toBe(TEXT);
  });

  it('a workspace scope never touches the vault', async () => {
    const vault = new FakeVault();
    const m = memory();
    await addStaffMemory(
      { memory: m, vault },
      { accountId: ACCOUNT, userId: USER, scope: WORKSPACE, content: TEXT }
    );
    expect(vault.puts).toEqual([]);
    expect(m.put.mock.calls[0]![2]).toBe(TEXT);
  });

  it('puts verified, source staff, created by the caller, importance 3 by default, kind / importance / supersedes passed', async () => {
    const m = memory();
    await addStaffMemory(
      { memory: m, vault: null },
      { accountId: ACCOUNT, userId: USER, scope: CONTACT, content: 'likes tea' }
    );
    await addStaffMemory(
      { memory: m, vault: null },
      {
        accountId: ACCOUNT,
        userId: USER,
        scope: CONTACT,
        content: 'prefers Arabic',
        kind: 'preference',
        importance: 5,
        supersedes: 'item-0',
      }
    );
    const [a, b] = m.put.mock.calls.map((c) => c[3]);
    expect(a).toMatchObject({
      importance: 3,
      trust: 'verified',
      sourceType: 'staff',
      createdBy: USER,
      supersedes: null,
    });
    expect(a!.origin).toMatchObject({
      origin: 'human',
      userId: USER,
      workspaceId: ACCOUNT,
      channel: 'dashboard',
    });
    expect(b).toMatchObject({
      kind: 'preference',
      importance: 5,
      supersedes: 'item-0',
    });
  });

  it('the minted origin is accepted by the real store for this account only: memory_put is sent verified', async () => {
    const calls: Record<string, unknown>[] = [];
    const db = {
      async rpc(_fn: string, args: Record<string, unknown>) {
        calls.push(args);
        return {
          data: [
            {
              item_id: 'item-1',
              deduped: false,
              evicted: 0,
              item_trust: args.p_trust,
              item_importance: args.p_importance,
            },
          ],
          error: null,
        };
      },
    } as unknown as SupabaseClient;
    const store = new MemoryStore(db);
    const r = await addStaffMemory(
      { memory: store, vault: null },
      { accountId: ACCOUNT, userId: USER, scope: CONTACT, content: 'likes tea' }
    );
    expect(r).toMatchObject({ ok: true, trust: 'verified', importance: 3 });
    expect(calls[0]).toMatchObject({
      p_account_id: ACCOUNT,
      p_trust: 'verified',
      p_importance: 3,
      p_source_type: 'staff',
      p_created_by: USER,
    });
  });
});
