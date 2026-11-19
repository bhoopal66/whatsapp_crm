import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, type FakeDb } from '@/lib/groups/test-db';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  get: vi.fn(),
  sendFromCrm: vi.fn(),
  sendMediaFromCrm: vi.fn(),
  service: vi.fn(),
  admin: null as unknown as FakeDb,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  submissionGroupStore: () => ({ get: mocks.get }),
  submissionGroupService: mocks.service,
  supabaseAdmin: () => fakeSupabase(mocks.admin),
}));

import { GROUP_SEND_LIMIT } from '@/lib/groups/member-requests';
import {
  SubmissionGroupSendBlockedError,
  SubmissionGroupSendRefusedError,
  SubmissionGroupSentNotRecordedError,
} from '@/lib/submission-groups/service';
import { SubmissionGroupDbError } from '@/lib/submission-groups/store';

import { POST } from './route';

const G = '22222222-2222-4222-8222-222222222222';
const params = (id = G) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown, id = G) =>
  POST(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
    params(id)
  );
const outRow = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `m${i}`,
  account_id: 'acct-1',
  group_id: G,
  direction: 'out',
  sender_user_id: 'agent-1',
  created_at: new Date().toISOString(),
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.admin = { tables: { submission_group_messages: [] } };
  mocks.getCurrentAccount.mockResolvedValue({
    userId: 'agent-1',
    accountId: 'acct-1',
    role: 'agent',
  });
  mocks.get.mockResolvedValue({ id: G, accountId: 'acct-1' });
  mocks.service.mockReturnValue({ sendFromCrm: mocks.sendFromCrm });
  mocks.sendFromCrm.mockResolvedValue({
    messageId: '7',
    prefixedBody: '*Aya (Agent):* hi',
    waMessageId: 'wa-1',
  });
});

describe('POST messages', () => {
  it('is 403 for a sales-restricted department, before any group read', async () => {
    mocks.getCurrentAccount.mockResolvedValue({
      userId: 'agent-1',
      accountId: 'acct-1',
      role: 'agent',
      salesRestricted: true,
    });
    expect((await post({ text: 'hi' })).status).toBe(403);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.sendFromCrm).not.toHaveBeenCalled();
  });

  it('sends the trimmed text as the caller and answers 201', async () => {
    const res = await post({ text: '  hi  ' });
    expect(res.status).toBe(201);
    expect((await res.json()).message.waMessageId).toBe('wa-1');
    expect(mocks.service).toHaveBeenCalledWith('acct-1');
    expect(mocks.sendFromCrm).toHaveBeenCalledWith({
      groupId: G,
      userId: 'agent-1',
      text: 'hi',
    });
  });

  it("answers 404 for another account's group and sends nothing", async () => {
    mocks.get.mockResolvedValue({ id: G, accountId: 'acct-2' });
    const res = await post({ text: 'hi' });
    expect(res.status).toBe(404);
    expect(mocks.sendFromCrm).not.toHaveBeenCalled();
  });

  it('answers 404 for a missing group or a non-uuid id', async () => {
    mocks.get.mockResolvedValue(null);
    expect((await post({ text: 'hi' })).status).toBe(404);
    expect((await post({ text: 'hi' }, 'nope')).status).toBe(404);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.sendFromCrm).not.toHaveBeenCalled();
  });

  it('rejects an empty text with 400', async () => {
    expect((await post({ text: '   ' })).status).toBe(400);
    expect(mocks.sendFromCrm).not.toHaveBeenCalled();
  });

  it('answers 429 at the per-person limit, counting only own out rows', async () => {
    const rows = Array.from(
      { length: GROUP_SEND_LIMIT.perWindow - 1 },
      (_, i) => outRow(i)
    );
    mocks.admin.tables.submission_group_messages = [
      ...rows,
      outRow(100, { sender_user_id: 'agent-2' }),
      outRow(101, { direction: 'in', sender_user_id: null }),
      outRow(102, {
        created_at: new Date(
          Date.now() - GROUP_SEND_LIMIT.windowMs - 1000
        ).toISOString(),
      }),
    ];
    expect((await post({ text: 'hi' })).status).toBe(201);

    mocks.admin.tables.submission_group_messages.push(outRow(103));
    const res = await post({ text: 'hi' });
    expect(res.status).toBe(429);
    expect(mocks.sendFromCrm).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['GROUP_NOT_FOUND', 404],
    ['GROUP_NOT_READY', 409],
    ['SEND_NOT_ALLOWED', 403],
    ['UNKNOWN_USER', 403],
  ] as const)('maps refusal %s to %i', async (reason, status) => {
    mocks.sendFromCrm.mockRejectedValue(
      new SubmissionGroupSendRefusedError(reason)
    );
    expect((await post({ text: 'hi' })).status).toBe(status);
  });

  it('answers 409 with the reason when consent blocks the send', async () => {
    mocks.sendFromCrm.mockRejectedValue(
      new SubmissionGroupSendBlockedError('opted_out')
    );
    const res = await post({ text: 'hi' });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('opted_out');
  });

  it('answers a generic 502 when the gateway fails', async () => {
    mocks.sendFromCrm.mockRejectedValue(new Error('whapi 500: secret detail'));
    const res = await post({ text: 'hi' });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('secret');
  });

  describe('media', () => {
    const PATH = 'account-acct-1/groups/1731999999999-scan.pdf';
    const media = (extra: Record<string, unknown> = {}) => ({
      media: {
        kind: 'document',
        url: `https://evil.example/storage/v1/object/public/chat-media/${PATH}`,
        path: PATH,
        caption: ' the form ',
        filename: 'scan.pdf',
        mimeType: 'application/pdf',
        ...extra,
      },
    });
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.org');
      mocks.service.mockReturnValue({
        sendFromCrm: mocks.sendFromCrm,
        sendMediaFromCrm: mocks.sendMediaFromCrm,
      });
      mocks.sendMediaFromCrm.mockResolvedValue({
        messageId: '8',
        prefixedBody: 'Aya (Agent): the form',
        waMessageId: 'wa-2',
      });
    });
    afterEach(() => vi.unstubAllEnvs());

    it('sends an own upload with a link rebuilt on the public origin, 201', async () => {
      const res = await post(media());
      expect(res.status).toBe(201);
      expect(mocks.sendMediaFromCrm).toHaveBeenCalledWith({
        groupId: G,
        userId: 'agent-1',
        kind: 'document',
        link: `https://db.example.org/storage/v1/object/public/chat-media/${PATH}`,
        path: PATH,
        caption: 'the form',
        filename: 'scan.pdf',
        mimeType: 'application/pdf',
      });
      expect(mocks.sendFromCrm).not.toHaveBeenCalled();
    });

    it('answers 400 for a URL outside chat-media groups uploads', async () => {
      const res = await post(
        media({ url: 'https://evil.example/payload.pdf', path: PATH })
      );
      expect(res.status).toBe(400);
      expect(mocks.sendMediaFromCrm).not.toHaveBeenCalled();
    });

    it("answers 400 for another account's folder", async () => {
      const other = 'account-acct-2/groups/1-scan.pdf';
      const res = await post(
        media({
          url: `https://db.example.org/storage/v1/object/public/chat-media/${other}`,
          path: other,
        })
      );
      expect(res.status).toBe(400);
      expect(mocks.sendMediaFromCrm).not.toHaveBeenCalled();
    });

    it('answers 400 for a bad kind or an over-long caption', async () => {
      expect((await post(media({ kind: 'sticker' }))).status).toBe(400);
      expect((await post(media({ caption: 'x'.repeat(1025) }))).status).toBe(
        400
      );
      expect(mocks.sendMediaFromCrm).not.toHaveBeenCalled();
    });

    it('maps a 22023 refusal from the begin RPC to 400', async () => {
      mocks.sendMediaFromCrm.mockRejectedValue(
        new SubmissionGroupDbError('bad media', '22023')
      );
      expect((await post(media())).status).toBe(400);
    });

    it('counts toward the same send limit (429)', async () => {
      mocks.admin.tables.submission_group_messages = Array.from(
        { length: GROUP_SEND_LIMIT.perWindow },
        (_, i) => outRow(i)
      );
      expect((await post(media())).status).toBe(429);
      expect(mocks.sendMediaFromCrm).not.toHaveBeenCalled();
    });
  });

  it('answers 202 sent:true when WhatsApp took the message but the row was not settled', async () => {
    mocks.sendFromCrm.mockRejectedValue(
      new SubmissionGroupSentNotRecordedError('m-1', 'wamid.1', new Error('x'))
    );
    const res = await post({ text: 'hi' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      error: 'Sent, but not recorded yet',
      sent: true,
    });
  });
});
