// The tap-to-classify intake's Supabase adapter (183), over a fake
// service-role client: only the mapping lives here, the rules are the core's.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: vi.fn(() => ({})),
  submissionGroupService: vi.fn(() => ({})),
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import { SubmissionGroupSentNotRecordedError } from '@/lib/submission-groups/service';

import { CaseHttpError } from './http';
import { caseIntakePorts } from './server';
import { CaseRefusedError } from './store';

type Res = { data: unknown; error: { code?: string; hint?: string } | null };

function fakeAdmin(opts: {
  rpc?: (fn: string, args: Record<string, unknown>) => Res;
  from?: (table: string) => Res;
  calls?: string[];
}) {
  const calls = opts.calls ?? [];
  const admin = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push(`rpc:${fn}`);
      return opts.rpc ? opts.rpc(fn, args) : { data: null, error: null };
    }),
    from: (table: string) => {
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => {
          calls.push(`from:${table}`);
          return opts.from ? opts.from(table) : { data: null, error: null };
        },
      };
      return b;
    },
  };
  return admin as unknown as SupabaseClient & { rpc: typeof admin.rpc };
}

const SEND = {
  accountId: 'acc-1',
  caseId: 'case-1',
  groupId: 'sg-1',
  coordinatorId: 'user-1',
  text: 'Which document is this?',
};

describe('caseIntakePorts', () => {
  it("asks for 'document_classify' when the core asks for 'classify'", async () => {
    const admin = fakeAdmin({ rpc: () => ({ data: 'Body', error: null }) });
    const ports = caseIntakePorts(admin);
    await expect(ports.approvedTemplate('acc-1', 'classify')).resolves.toBe(
      'Body'
    );
    await ports.approvedTemplate('acc-1', 'document_rejected');
    await ports.approvedTemplate('acc-1', 'document_received_next');
    expect(admin.rpc.mock.calls.map((c) => c[1])).toEqual([
      { p_account: 'acc-1', p_kind: 'document_classify' },
      { p_account: 'acc-1', p_kind: 'document_rejected' },
      { p_account: 'acc-1', p_kind: 'document_received_next' },
    ]);
  });

  it('reads anything but a non-empty string as not approved', async () => {
    for (const data of [null, '', 42, { body: 'x' }]) {
      const ports = caseIntakePorts(
        fakeAdmin({ rpc: () => ({ data, error: null }) })
      );
      await expect(ports.approvedTemplate('acc-1', 'classify')).resolves.toBe(
        null
      );
    }
  });

  describe('send', () => {
    it('checks the send limit, then replies as the coordinator', async () => {
      const order: string[] = [];
      const ports = caseIntakePorts(fakeAdmin({}), {
        assertSendLimit: vi.fn(async (...a: unknown[]) => {
          order.push(`limit ${a.join(' ')}`);
        }),
        reply: vi.fn(async (...a: unknown[]) => {
          order.push(`reply ${a.join(' ')}`);
        }),
      });
      await expect(ports.send(SEND)).resolves.toEqual({
        sent: true,
        recorded: true,
      });
      expect(order).toEqual([
        'limit acc-1 sg-1 user-1',
        'reply acc-1 user-1 case-1 Which document is this?',
      ]);
    });

    it('counts a sent-but-not-recorded send as sent', async () => {
      const ports = caseIntakePorts(fakeAdmin({}), {
        assertSendLimit: async () => {},
        reply: async () => {
          throw new SubmissionGroupSentNotRecordedError('m', 'w', null);
        },
      });
      await expect(ports.send(SEND)).resolves.toEqual({
        sent: true,
        recorded: false,
      });
    });

    it('names a refusal by reason, then extra.code, then the error name', async () => {
      const limited = vi.fn();
      const cases: [() => never, string][] = [
        [
          () => {
            throw new CaseRefusedError('NOT_ALLOWED');
          },
          'NOT_ALLOWED',
        ],
        [
          () => {
            throw new CaseHttpError(429, 'slow down', {
              code: 'SEND_RATE_LIMITED',
            });
          },
          'SEND_RATE_LIMITED',
        ],
        [
          () => {
            throw new TypeError('boom');
          },
          'TypeError',
        ],
      ];
      for (const [thrower, code] of cases) {
        const ports = caseIntakePorts(fakeAdmin({}), {
          assertSendLimit: async () => {},
          reply: async () => thrower(),
        });
        await expect(ports.send(SEND)).resolves.toEqual({ sent: false, code });
      }
      // Over the limit: nothing is sent.
      const ports = caseIntakePorts(fakeAdmin({}), {
        assertSendLimit: async () => {
          throw new CaseHttpError(429, 'slow down', {
            code: 'SEND_RATE_LIMITED',
          });
        },
        reply: limited,
      });
      await expect(ports.send(SEND)).resolves.toEqual({
        sent: false,
        code: 'SEND_RATE_LIMITED',
      });
      expect(limited).not.toHaveBeenCalled();
    });
  });

  describe('answerPrompt', () => {
    const ANSWER = { promptId: 'p-1', choice: 2, now: new Date(0) };

    it('reads the file id before spending the answer', async () => {
      const calls: string[] = [];
      const admin = fakeAdmin({
        calls,
        from: () => ({ data: { file_id: 'file-1' }, error: null }),
        rpc: () => ({ data: 'payslip', error: null }),
      });
      await expect(
        caseIntakePorts(admin).answerPrompt(ANSWER)
      ).resolves.toEqual({ fileId: 'file-1', docKey: 'payslip' });
      expect(calls).toEqual([
        'from:case_intake_prompts',
        'rpc:case_intake_prompt_answer',
      ]);
      expect(admin.rpc).toHaveBeenCalledWith('case_intake_prompt_answer', {
        p_prompt: 'p-1',
        p_n: 2,
        p_now: '1970-01-01T00:00:00.000Z',
      });
    });

    it('a failed read leaves the prompt unanswered', async () => {
      const admin = fakeAdmin({
        from: () => ({ data: null, error: { code: '57014' } }),
      });
      await expect(
        caseIntakePorts(admin).answerPrompt(ANSWER)
      ).rejects.toThrow();
      expect(admin.rpc).not.toHaveBeenCalled();
    });

    it('throws the SQL refusal carrying its hint', async () => {
      const admin = fakeAdmin({
        from: () => ({ data: { file_id: 'file-1' }, error: null }),
        rpc: () => ({ data: null, error: { hint: 'PROMPT_ANSWERED' } }),
      });
      await expect(
        caseIntakePorts(admin).answerPrompt(ANSWER)
      ).rejects.toMatchObject({ hint: 'PROMPT_ANSWERED' });
    });
  });
});
