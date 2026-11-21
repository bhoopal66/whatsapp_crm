import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: vi.fn() }));

import { assertAiTransfer, makeTransferCheck, promptSize } from './ai-transfer';

describe('AI transfer check', () => {
  it('asks the database and answers its decision', async () => {
    const rpc = vi.fn(async () => ({ data: false, error: null }));
    const check = makeTransferCheck(() => ({ rpc }) as never);
    expect(
      await check({
        accountId: 'a',
        destination: 'openai',
        purpose: 'reply',
        model: 'm',
        bytes: 10.4,
      })
    ).toBe(false);
    expect(rpc).toHaveBeenCalledWith('ai_transfer_check', {
      p_account: 'a',
      p_destination: 'openai',
      p_purpose: 'reply',
      p_model: 'm',
      p_bytes: 10,
    });
  });

  it('fails open when the check cannot run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = makeTransferCheck(
      () =>
        ({
          rpc: async () => ({ data: null, error: { code: '42883' } }),
        }) as never
    );
    expect(
      await broken({
        accountId: 'a',
        destination: 'anthropic',
        purpose: 'draft',
        model: null,
        bytes: 1,
      })
    ).toBe(true);
    const thrown = makeTransferCheck(() => {
      throw new Error('down');
    });
    expect(
      await thrown({
        accountId: 'a',
        destination: 'anthropic',
        purpose: 'draft',
        model: null,
        bytes: 1,
      })
    ).toBe(true);
  });

  it('throws transfer_basis_required only when refused, and skips configs without an account', async () => {
    const no = vi.fn(async () => false);
    await expect(
      assertAiTransfer(
        { accountId: 'a', provider: 'openai' },
        'reply',
        'm',
        1,
        no
      )
    ).rejects.toMatchObject({
      code: 'transfer_basis_required',
      status: 451,
    });
    await expect(
      assertAiTransfer({ provider: 'openai' }, 'reply', 'm', 1, no)
    ).resolves.toBeUndefined();
    expect(no).toHaveBeenCalledTimes(1);
    await expect(
      assertAiTransfer(
        { accountId: 'a', provider: 'anthropic' },
        'reply',
        'm',
        1,
        async () => true
      )
    ).resolves.toBeUndefined();
  });

  it('sizes a prompt', () => {
    expect(
      promptSize('ab', [{ content: 'cde' }, { content: [{ x: 1 }] }])
    ).toBe(2 + 3 + 9);
  });
});
