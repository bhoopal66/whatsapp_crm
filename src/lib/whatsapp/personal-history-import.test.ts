import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { encrypt } from './encryption';
import {
  findOrCreateContact,
  findOrCreatePersonalChat,
} from './inbound-pipeline';
import {
  OpenWAError,
  getChatHistory,
  getContactPhone,
  getSession,
  listChats,
  type OpenWAChatSummary,
  type OpenWAHistoryMessage,
} from './openwa-api';
import {
  PAUSED_RETRY_MS,
  historyMessageToRow,
  isImportableChat,
  runPersonalHistoryImportTick,
} from './personal-history-import';

vi.mock('./inbound-pipeline', () => ({
  findOrCreateContact: vi.fn(),
  findOrCreatePersonalChat: vi.fn(),
}));
vi.mock('./openwa-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./openwa-api')>()),
  listChats: vi.fn(),
  getChatHistory: vi.fn(),
  getContactPhone: vi.fn(),
  getSession: vi.fn(),
}));

const OWNER = 'user-owner';
const CONFIG = 'cfg-1';
const ACCOUNT = 'acc-1';
const ctx = { ownerId: OWNER, channelId: CONFIG };

function msg(over: Partial<OpenWAHistoryMessage>): OpenWAHistoryMessage {
  return {
    id: 'false_971500000001@c.us_AAA',
    body: '',
    type: 'text',
    timestamp: 1700000000,
    fromMe: false,
    ...over,
  };
}

// ============================================================
// Mapping
// ============================================================

describe('historyMessageToRow', () => {
  it('maps a customer text', () => {
    expect(historyMessageToRow(msg({ body: ' hello ' }), ctx)).toEqual({
      sender_type: 'customer',
      sender_id: null,
      content_type: 'text',
      content_text: 'hello',
      message_id: 'false_971500000001@c.us_AAA',
      status: 'delivered',
      provider: 'openwa',
      channel_id: CONFIG,
      created_at: '2023-11-14T22:13:20.000Z',
    });
  });

  it("maps the owner's own message as an agent row sent by the owner", () => {
    const row = historyMessageToRow(msg({ body: 'hi', fromMe: true }), ctx);
    expect(row).toMatchObject({
      sender_type: 'agent',
      sender_id: OWNER,
      status: 'sent',
    });
  });

  const vcard =
    'BEGIN:VCARD\nVERSION:3.0\nFN:Sara K\nTEL:+971501112222\nEND:VCARD';
  it.each<[Partial<OpenWAHistoryMessage>, string | null]>([
    [{ type: 'image', body: 'look' }, '[photo]\nlook'],
    [{ type: 'image' }, '[photo]'],
    [{ type: 'video', body: 'clip' }, '[video]\nclip'],
    [{ type: 'document', body: 'cv.pdf' }, '[document]\ncv.pdf'],
    [{ type: 'audio' }, '[audio]'],
    [{ type: 'voice' }, '[voice note]'],
    [{ type: 'sticker' }, '[sticker]'],
    [
      { type: 'location', location: { description: 'Office', address: 'X' } },
      '[location: Office]',
    ],
    [
      { type: 'location', location: { address: 'Marina' } },
      '[location: Marina]',
    ],
    [{ type: 'contact', body: vcard }, 'Contact: Sara K'],
    [{ type: 'poll', poll: { name: 'Lunch?' } }, '[poll: Lunch?]'],
    [{ type: 'call' }, '[call]'],
    [{ type: 'text', body: '   ' }, null],
    [{ type: 'contact', body: '' }, null],
    [{ type: 'revoked' }, null],
    [{ type: 'order' }, null],
    [{ type: 'product' }, null],
    [{ type: 'unknown' }, null],
  ])('maps %o to %j', (over, text) => {
    const row = historyMessageToRow(msg(over), ctx);
    expect(row?.content_text ?? null).toBe(text);
  });

  it('drops a message without an id or a timestamp', () => {
    expect(historyMessageToRow(msg({ id: '', body: 'x' }), ctx)).toBeNull();
    expect(
      historyMessageToRow(msg({ body: 'x', timestamp: undefined }), ctx)
    ).toBeNull();
  });
});

describe('isImportableChat', () => {
  const chat = (over: Partial<OpenWAChatSummary>): OpenWAChatSummary => ({
    id: '971500000001@c.us',
    name: null,
    kind: 'individual',
    isGroup: false,
    timestamp: 1,
    ...over,
  });
  it('takes one-to-one chats only', () => {
    expect(isImportableChat(chat({}))).toBe(true);
    expect(isImportableChat(chat({ id: '123@lid' }))).toBe(true);
    expect(
      isImportableChat(chat({ id: '1@g.us', kind: 'group', isGroup: true }))
    ).toBe(false);
    expect(isImportableChat(chat({ kind: 'channel' }))).toBe(false);
    expect(isImportableChat(chat({ kind: 'status' }))).toBe(false);
    expect(isImportableChat(chat({ kind: 'broadcast' }))).toBe(false);
    expect(isImportableChat(chat({ id: 'status@broadcast' }))).toBe(false);
  });
});

// ============================================================
// Fake database
// ============================================================

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>) {
  const seen = new Set<string>();
  const rpcCalls: Array<{ name: string; args: Row }> = [];
  const failRpc: Record<string, string> = {};

  function from(table: string) {
    tables[table] ??= [];
    let op: 'select' | 'update' | 'upsert' = 'select';
    let patch: Row = {};
    let upsertRows: Row[] = [];
    let conflict: string[] = [];
    const filters: Array<(r: Row) => boolean> = [];
    let orderBy: { col: string; asc: boolean } | null = null;
    let max = Infinity;

    const run = () => {
      const rows = tables[table];
      if (op === 'upsert') {
        for (const r of upsertRows) {
          const dup = rows.some((x) => conflict.every((k) => x[k] === r[k]));
          if (!dup) rows.push({ ...r });
        }
        return { data: null, error: null };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'update') {
        hit.forEach((r) => Object.assign(r, patch));
        return { data: null, error: null };
      }
      if (orderBy) {
        const { col, asc } = orderBy;
        hit.sort((a, b) => {
          const x = String(a[col] ?? '');
          const y = String(b[col] ?? '');
          return asc ? x.localeCompare(y) : y.localeCompare(x);
        });
      }
      return { data: hit.slice(0, max).map((r) => ({ ...r })), error: null };
    };

    const b = {
      select: () => b,
      update: (p: Row) => ((op = 'update'), (patch = p), b),
      upsert: (rows: Row[], o: { onConflict: string }) => {
        op = 'upsert';
        upsertRows = rows;
        conflict = o.onConflict.split(',');
        return b;
      },
      eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), b),
      not: (col: string) => (filters.push((r) => r[col] != null), b),
      order: (col: string, o: { ascending: boolean }) => (
        (orderBy = { col, asc: o.ascending }),
        b
      ),
      limit: (n: number) => ((max = n), b),
      maybeSingle: async () => {
        const { data } = run();
        return { data: (data as Row[])[0] ?? null, error: null };
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(ok, bad),
    };
    return b;
  }

  async function rpc(name: string, args: Row) {
    rpcCalls.push({ name, args });
    if (failRpc[name]) return { data: null, error: { message: failRpc[name] } };
    if (name === 'claim_personal_history_import') {
      const job = tables.personal_history_imports.find(
        (j) =>
          ['queued', 'listing', 'running', 'paused'].includes(
            String(j.status)
          ) &&
          (j.lease_until == null ||
            (j.lease_until !== 'leased' &&
              Date.parse(String(j.lease_until)) < Date.now()))
      );
      if (!job) return { data: [], error: null };
      job.lease_until = 'leased';
      return { data: [{ ...job }], error: null };
    }
    if (name === 'import_history_rows') {
      let n = 0;
      for (const r of args.p_rows as Row[]) {
        const key = `${args.p_conversation_id}:${r.message_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        n++;
      }
      return { data: n, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  }

  const client = { from, rpc } as unknown as SupabaseClient;
  return { client, tables, rpcCalls, failRpc };
}

function configRow(over: Row = {}): Row {
  return {
    id: CONFIG,
    account_id: ACCOUNT,
    provider: 'openwa',
    label: null,
    phone_number_id: 'sess-1',
    waba_id: '971509999999',
    access_token: encrypt('op-key'),
    app_secret: null,
    is_primary: false,
    mirror_inbound_media: true,
    status: 'connected',
    created_at: '2026-11-01T00:00:00Z',
    connected_at: '2026-11-01T00:00:00Z',
    is_personal: true,
    user_id: OWNER,
    ...over,
  };
}

function chatSummary(
  id: string,
  ts: number,
  over: Partial<OpenWAChatSummary> = {}
) {
  return {
    id,
    name: `n-${id}`,
    kind: 'individual',
    isGroup: false,
    timestamp: ts,
    ...over,
  };
}

const listChatsMock = vi.mocked(listChats);
const historyMock = vi.mocked(getChatHistory);
const phoneMock = vi.mocked(getContactPhone);
const sessionMock = vi.mocked(getSession);
const contactMock = vi.mocked(findOrCreateContact);
const chatMock = vi.mocked(findOrCreatePersonalChat);

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  contactMock.mockImplementation(async (_a, _o, phone) => ({
    contact: { id: `contact-${phone}` },
    wasCreated: true,
  }));
  chatMock.mockImplementation(async (_db, _a, contactId) => ({
    conversation: { id: `conv-${contactId}` },
    created: true,
  }));
  historyMock.mockImplementation(async ({ chatId }) => [
    msg({ id: `${chatId}-1`, body: 'hi' }),
    msg({ id: `${chatId}-2`, body: 'yo', fromMe: true }),
    msg({ id: `${chatId}-3`, type: 'revoked' }),
  ]);
});

const noPause = { pauseMs: 0, sleep: async () => {} };

function job(db: ReturnType<typeof fakeDb>) {
  return db.tables.personal_history_imports[0];
}
function chatRow(db: ReturnType<typeof fakeDb>, chatId: string) {
  return db.tables.personal_history_import_chats.find(
    (c) => c.chat_id === chatId
  );
}

// ============================================================
// The tick
// ============================================================

describe('runPersonalHistoryImportTick', () => {
  it('enqueues, lists, imports every chat and finishes in one tick', async () => {
    const db = fakeDb({
      whatsapp_config: [
        configRow(),
        configRow({ id: 'cfg-company', is_personal: false }),
      ],
    });
    listChatsMock.mockResolvedValueOnce([
      chatSummary('971500000001@c.us', 100),
      chatSummary('1203@g.us', 300, { kind: 'group', isGroup: true }),
      chatSummary('555@lid', 200),
    ]);
    phoneMock.mockResolvedValueOnce('971500000002');

    const res = await runPersonalHistoryImportTick(db.client, {
      budgetMs: 60_000,
      ...noPause,
    });

    expect(res).toMatchObject({
      enqueued: 1,
      configId: CONFIG,
      status: 'done',
    });
    expect(db.tables.personal_history_imports).toHaveLength(1);
    expect(job(db)).toMatchObject({
      status: 'done',
      chats_total: 2,
      chats_done: 2,
      messages_imported: 4,
      lease_until: null,
      last_error: null,
    });
    expect(job(db).finished_at).toBeTruthy();
    expect(listChatsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'op-key',
        sessionId: 'sess-1',
        limit: 1000,
        offset: 0,
      })
    );
    // Newest chat first: the @lid one (ts 200) before the @c.us one.
    expect(historyMock.mock.calls.map((c) => c[0].chatId)).toEqual([
      '555@lid',
      '971500000001@c.us',
    ]);
    expect(historyMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 2000, deep: true, timeoutMs: 40_000 })
    );
    expect(phoneMock).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: '555@lid' })
    );
    // The owner creates the contact, and no phone-book name renames one.
    expect(contactMock).toHaveBeenCalledWith(
      ACCOUNT,
      OWNER,
      '971500000002',
      'n-555@lid',
      { rename: false }
    );
    const imports = db.rpcCalls.filter((c) => c.name === 'import_history_rows');
    expect(imports[0].args.p_conversation_id).toBe('conv-contact-971500000002');
    expect(imports[0].args.p_rows).toHaveLength(2);
    expect(chatRow(db, '555@lid')).toMatchObject({
      status: 'done',
      messages_imported: 2,
    });
  });

  it('skips an @lid chat with no phone, and a chat with the own number', async () => {
    const db = fakeDb({ whatsapp_config: [configRow()] });
    listChatsMock.mockResolvedValueOnce([
      chatSummary('555@lid', 200),
      chatSummary('971509999999@c.us', 100),
    ]);
    phoneMock.mockResolvedValueOnce(null);

    await runPersonalHistoryImportTick(db.client, {
      budgetMs: 60_000,
      ...noPause,
    });

    expect(chatRow(db, '555@lid')).toMatchObject({ status: 'skipped' });
    expect(chatRow(db, '971509999999@c.us')).toMatchObject({
      status: 'skipped',
    });
    expect(historyMock).not.toHaveBeenCalled();
    expect(job(db)).toMatchObject({ status: 'done', messages_imported: 0 });
  });

  it('stops the tick, keeping the chat, when the contact lookup fails', async () => {
    const db = fakeDb({ whatsapp_config: [configRow()] });
    listChatsMock.mockResolvedValueOnce([chatSummary('971500000001@c.us', 1)]);
    contactMock.mockRejectedValueOnce(new Error('Contact lookup failed'));

    await runPersonalHistoryImportTick(db.client, {
      budgetMs: 60_000,
      ...noPause,
    });

    expect(chatRow(db, '971500000001@c.us')).toMatchObject({
      status: 'pending',
    });
    expect(job(db).last_error).toContain('contact lookup');
  });

  it('steps the read limit down after a timeout, then fails the chat after 3 tries', async () => {
    const db = fakeDb({ whatsapp_config: [configRow()] });
    listChatsMock.mockResolvedValueOnce([chatSummary('971500000001@c.us', 1)]);
    historyMock.mockRejectedValue(
      new OpenWAError('OpenWA request failed: timeout', 503)
    );

    await runPersonalHistoryImportTick(db.client, {
      budgetMs: 600_000,
      ...noPause,
    });

    expect(historyMock.mock.calls.map((c) => c[0].limit)).toEqual([
      2000, 500, 100,
    ]);
    expect(chatRow(db, '971500000001@c.us')).toMatchObject({
      status: 'failed',
      attempts: 3,
      next_limit: 100,
    });
    expect(String(chatRow(db, '971500000001@c.us')?.last_error)).toContain(
      'timeout'
    );
    expect(job(db)).toMatchObject({ status: 'done', lease_until: null });
  });

  it('retries at the smaller limit after one timeout and imports', async () => {
    const db = fakeDb({ whatsapp_config: [configRow()] });
    listChatsMock.mockResolvedValueOnce([chatSummary('971500000001@c.us', 1)]);
    historyMock.mockRejectedValueOnce(new OpenWAError('gateway', 504));

    await runPersonalHistoryImportTick(db.client, {
      budgetMs: 600_000,
      ...noPause,
    });

    expect(historyMock.mock.calls.map((c) => c[0].limit)).toEqual([2000, 500]);
    expect(chatRow(db, '971500000001@c.us')).toMatchObject({
      status: 'done',
      attempts: 1,
      next_limit: 500,
      messages_imported: 2,
    });
  });

  it('stops when the budget is spent and leaves the rest pending', async () => {
    const db = fakeDb({ whatsapp_config: [configRow()] });
    listChatsMock.mockResolvedValueOnce([
      chatSummary('971500000001@c.us', 3),
      chatSummary('971500000002@c.us', 2),
      chatSummary('971500000003@c.us', 1),
    ]);
    let t = 0;
    const base = historyMock.getMockImplementation()!;
    historyMock.mockImplementation(async (args) => {
      t += 20_000;
      return base(args);
    });

    const res = await runPersonalHistoryImportTick(db.client, {
      budgetMs: 45_000,
      now: () => t,
      ...noPause,
    });

    expect(historyMock).toHaveBeenCalledTimes(2);
    expect(historyMock.mock.calls[1][0].timeoutMs).toBe(20_000);
    expect(chatRow(db, '971500000003@c.us')).toMatchObject({
      status: 'pending',
    });
    expect(job(db)).toMatchObject({
      status: 'running',
      chats_total: 3,
      chats_done: 2,
      messages_imported: 4,
      lease_until: null,
    });
    expect(res).toMatchObject({ chatsDone: 2, messagesImported: 4 });
  });

  it('pauses a job whose number is disconnected, touching no gateway', async () => {
    const db = fakeDb({
      whatsapp_config: [configRow({ status: 'disconnected' })],
      personal_history_imports: [
        {
          config_id: CONFIG,
          account_id: ACCOUNT,
          user_id: OWNER,
          status: 'running',
          lease_until: null,
        },
      ],
    });

    const res = await runPersonalHistoryImportTick(db.client, {
      budgetMs: 60_000,
      ...noPause,
    });

    expect(res.status).toBe('paused');
    // It steps aside for PAUSED_RETRY_MS instead of releasing at once.
    expect(job(db).status).toBe('paused');
    const held = Date.parse(String(job(db).lease_until)) - Date.now();
    expect(held).toBeGreaterThan(PAUSED_RETRY_MS - 60_000);
    expect(held).toBeLessThanOrEqual(PAUSED_RETRY_MS);
    expect(listChatsMock).not.toHaveBeenCalled();
    expect(historyMock).not.toHaveBeenCalled();
  });

  it('lets a newer job run while an older one waits on a logged-out number', async () => {
    const db = fakeDb({
      whatsapp_config: [
        configRow({ status: 'disconnected' }),
        configRow({ id: 'cfg-2', phone_number_id: 'sess-2', user_id: 'u-2' }),
      ],
      personal_history_imports: [
        {
          config_id: CONFIG,
          account_id: ACCOUNT,
          user_id: OWNER,
          status: 'paused',
          lease_until: null,
        },
        {
          config_id: 'cfg-2',
          account_id: ACCOUNT,
          user_id: 'u-2',
          status: 'queued',
          lease_until: null,
        },
      ],
    });
    listChatsMock.mockResolvedValue([]);

    const first = await runPersonalHistoryImportTick(db.client, {
      budgetMs: 60_000,
      ...noPause,
    });
    expect(first).toMatchObject({ configId: CONFIG, status: 'paused' });

    const second = await runPersonalHistoryImportTick(db.client, {
      budgetMs: 60_000,
      ...noPause,
    });
    expect(second).toMatchObject({ configId: 'cfg-2', status: 'done' });
  });

  it('is done when nothing is pending', async () => {
    const db = fakeDb({
      whatsapp_config: [configRow()],
      personal_history_imports: [
        {
          config_id: CONFIG,
          account_id: ACCOUNT,
          user_id: OWNER,
          status: 'running',
          lease_until: null,
        },
      ],
      personal_history_import_chats: [
        { config_id: CONFIG, chat_id: 'a@c.us', status: 'done' },
      ],
    });

    await runPersonalHistoryImportTick(db.client, {
      budgetMs: 60_000,
      ...noPause,
    });

    expect(job(db)).toMatchObject({ status: 'done', lease_until: null });
    expect(job(db).finished_at).toBeTruthy();
    expect(listChatsMock).not.toHaveBeenCalled();
  });

  it('imports nothing twice when a chat is replayed', async () => {
    const db = fakeDb({ whatsapp_config: [configRow()] });
    listChatsMock.mockResolvedValue([chatSummary('971500000001@c.us', 1)]);
    await runPersonalHistoryImportTick(db.client, {
      budgetMs: 60_000,
      ...noPause,
    });
    expect(job(db).messages_imported).toBe(2);

    // A lost "done" write: the chat is read and sent again.
    chatRow(db, '971500000001@c.us')!.status = 'pending';
    job(db).status = 'running';
    await runPersonalHistoryImportTick(db.client, {
      budgetMs: 60_000,
      ...noPause,
    });

    const imports = db.rpcCalls.filter((c) => c.name === 'import_history_rows');
    expect(imports).toHaveLength(2);
    expect(chatRow(db, '971500000001@c.us')).toMatchObject({
      status: 'done',
      messages_imported: 0,
    });
    expect(job(db)).toMatchObject({ status: 'done', messages_imported: 2 });
  });

  it('records a failure, releases the lease and never throws', async () => {
    const db = fakeDb({ whatsapp_config: [configRow()] });
    listChatsMock.mockResolvedValueOnce([chatSummary('971500000001@c.us', 1)]);
    db.failRpc.import_history_rows = 'boom';

    const res = await runPersonalHistoryImportTick(db.client, {
      budgetMs: 60_000,
      ...noPause,
    });

    expect(res.status).toBe('running');
    expect(job(db)).toMatchObject({ status: 'running', lease_until: null });
    expect(String(job(db).last_error)).toContain('boom');
    expect(chatRow(db, '971500000001@c.us')).toMatchObject({
      status: 'pending',
    });
  });

  it('stops on a session-level refusal without spending attempts', async () => {
    const db = fakeDb({ whatsapp_config: [configRow()] });
    listChatsMock.mockResolvedValueOnce([chatSummary('971500000001@c.us', 1)]);
    historyMock.mockRejectedValueOnce(new OpenWAError('not ready', 409));
    sessionMock.mockRejectedValueOnce(new OpenWAError('not ready', 409));

    await runPersonalHistoryImportTick(db.client, {
      budgetMs: 60_000,
      ...noPause,
    });

    expect(chatRow(db, '971500000001@c.us')).toMatchObject({
      status: 'pending',
    });
    expect(chatRow(db, '971500000001@c.us')?.attempts).toBeUndefined();
    expect(job(db)).toMatchObject({ status: 'running', lease_until: null });
  });

  it('fails one bad chat on a per-chat 4xx and imports the next in the same tick', async () => {
    const db = fakeDb({ whatsapp_config: [configRow()] });
    listChatsMock.mockResolvedValueOnce([
      chatSummary('971500000002@c.us', 2),
      chatSummary('971500000001@c.us', 1),
    ]);
    historyMock.mockImplementation(async ({ chatId }) => {
      if (chatId === '971500000002@c.us') {
        throw new OpenWAError('bad chat', 400, { route: 'message' });
      }
      return [msg({ id: `${chatId}-1`, body: 'hi' })];
    });

    await runPersonalHistoryImportTick(db.client, {
      budgetMs: 600_000,
      ...noPause,
    });

    expect(chatRow(db, '971500000002@c.us')).toMatchObject({
      status: 'failed',
      attempts: 1,
    });
    expect(chatRow(db, '971500000001@c.us')).toMatchObject({ status: 'done' });
    expect(job(db)).toMatchObject({ status: 'done' });
  });

  it('does not stall on a per-chat 4xx from the @lid phone lookup', async () => {
    const db = fakeDb({ whatsapp_config: [configRow()] });
    listChatsMock.mockResolvedValueOnce([
      chatSummary('abc@lid', 2),
      chatSummary('971500000001@c.us', 1),
    ]);
    phoneMock.mockRejectedValueOnce(new OpenWAError('bad', 400));

    await runPersonalHistoryImportTick(db.client, {
      budgetMs: 600_000,
      ...noPause,
    });

    expect(chatRow(db, 'abc@lid')).toMatchObject({ status: 'failed' });
    expect(chatRow(db, '971500000001@c.us')).toMatchObject({ status: 'done' });
  });

  it('does nothing when no job is claimable', async () => {
    const db = fakeDb({ whatsapp_config: [] });
    const res = await runPersonalHistoryImportTick(db.client, {
      budgetMs: 60_000,
      ...noPause,
    });
    expect(res).toMatchObject({ enqueued: 0, configId: null });
  });

  it('survives a failed claim', async () => {
    const db = fakeDb({ whatsapp_config: [configRow()] });
    db.failRpc.claim_personal_history_import = 'down';
    await expect(
      runPersonalHistoryImportTick(db.client, { budgetMs: 60_000, ...noPause })
    ).resolves.toMatchObject({ configId: null });
  });
});
