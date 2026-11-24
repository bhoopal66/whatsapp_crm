import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/lib/case-files/bytes', () => ({ readDocumentBytes: h.read }));

import { routeDeskDocument } from './route-inbound';
import type { DeskStore } from './store';

const PDF = new TextEncoder().encode('%PDF-1.4 test');
const upload = vi.fn();
const DOC_ID = '11111111-1111-4111-8111-111111111111';
/** The customer_documents read: which filters it used, what it answers. */
const read = vi.fn();
const filters: [string, unknown][] = [];
const admin = {
  rpc: vi.fn(),
  from: (table: string) => {
    const b = {
      select: () => b,
      eq: (col: string, v: unknown) => {
        filters.push([`${table}.${col}`, v]);
        return b;
      },
      maybeSingle: () => read(),
    };
    return b;
  },
  storage: { from: () => ({ upload, download: vi.fn() }) },
} as unknown as Parameters<typeof routeDeskDocument>[0];
const input = {
  accountId: 'acct-1',
  messageRowId: 'msg-row-1',
  channelId: 'ch-1',
  mediaUrl: 'https://x/storage/v1/object/public/chat-media/a.pdf',
  mime: 'application/pdf',
  originalName: 'ejari.pdf',
  caption: '4271RAKD ejari',
};

function fakeStore(decision: Record<string, unknown>) {
  return {
    routeDocument: vi.fn().mockResolvedValue({
      action: 'staff',
      caseId: null,
      trayId: null,
      reason: null,
      staffUserId: 'staff-1',
      ...decision,
    }),
    bankByShortCode: vi.fn().mockResolvedValue('RAK'),
    trayCopyFailed: vi.fn().mockResolvedValue(true),
    whatsappIntake: vi.fn().mockResolvedValue({ itemId: 'x', state: 'filed' }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.read.mockResolvedValue(PDF);
  upload.mockResolvedValue({ error: null });
  filters.length = 0;
  read.mockResolvedValue({ data: { id: DOC_ID }, error: null });
});

describe('routeDeskDocument', () => {
  it("asks the SQL with the account, the message's document row and the number", async () => {
    const store = fakeStore({ action: 'tray', staffUserId: null });
    const d = await routeDeskDocument(
      admin,
      input,
      store as unknown as DeskStore
    );
    expect(store.routeDocument).toHaveBeenCalledWith('acct-1', DOC_ID, 'ch-1');
    // Found by the message it arrived on, in this workspace.
    expect(filters).toEqual([
      ['customer_documents.account_id', 'acct-1'],
      ['customer_documents.message_id', 'msg-row-1'],
    ]);
    expect(d?.action).toBe('tray');
    expect(store.whatsappIntake).not.toHaveBeenCalled();
  });

  it("turns a staff phone's document into a desk upload in their name, tagged from the caption", async () => {
    const store = fakeStore({});
    await routeDeskDocument(admin, input, store as unknown as DeskStore);
    expect(store.whatsappIntake).toHaveBeenCalledTimes(1);
    const [actor, account, body] = store.whatsappIntake.mock.calls[0]!;
    expect(actor).toBe('staff-1');
    expect(account).toBe('acct-1');
    // The document id is the item id and the idem key: a redelivery replays.
    expect(body.itemId).toBe(DOC_ID);
    expect(body.idemKey).toBe(`wa:${DOC_ID}`);
    expect(body.tags).toMatchObject({
      kind: 'pending_doc',
      caseRef: '4271RAKD',
    });
    expect(body.file.storagePath).toMatch(
      new RegExp(`^intake/${DOC_ID}/[0-9a-f]{64}\\.pdf$`)
    );
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("maps a NEW caption's desk code to the bank", async () => {
    const store = fakeStore({});
    await routeDeskDocument(
      admin,
      { ...input, caption: 'NEW RAK Kite General Trading 12345' },
      store as unknown as DeskStore
    );
    expect(store.bankByShortCode).toHaveBeenCalledWith('acct-1', 'RAK');
    expect(store.whatsappIntake.mock.calls[0]![2].tags).toMatchObject({
      kind: 'new_case',
      bankCode: 'RAK',
      tradeLicence: '12345',
    });
  });

  it('asks nothing when the recorded row cannot be read', async () => {
    for (const answer of [
      { data: null, error: null },
      { data: null, error: { code: '57014' } },
    ]) {
      read.mockResolvedValue(answer);
      const store = fakeStore({});
      await expect(
        routeDeskDocument(admin, input, store as unknown as DeskStore)
      ).resolves.toBeNull();
      expect(store.routeDocument).not.toHaveBeenCalled();
      expect(store.trayCopyFailed).toHaveBeenCalledWith(
        'acct-1',
        'msg-row-1',
        'ch-1'
      );
    }
  });

  it('never throws: a failed route or an unreadable file is only logged', async () => {
    const broken = fakeStore({});
    broken.routeDocument.mockRejectedValue(new Error('db down'));
    await expect(
      routeDeskDocument(admin, input, broken as unknown as DeskStore)
    ).resolves.toBeNull();

    h.read.mockResolvedValue(null);
    const store = fakeStore({});
    await expect(
      routeDeskDocument(admin, input, store as unknown as DeskStore)
    ).resolves.toMatchObject({ action: 'staff' });
    expect(store.whatsappIntake).not.toHaveBeenCalled();
    // Neither is lost to the desk (303): each leaves a tray row.
    expect(broken.trayCopyFailed).toHaveBeenCalledTimes(1);
    expect(store.trayCopyFailed).toHaveBeenCalledWith(
      'acct-1',
      'msg-row-1',
      'ch-1'
    );
  });

  it('tries the tray row twice, and writes none for a copied document', async () => {
    const copied = fakeStore({});
    await routeDeskDocument(admin, input, copied as unknown as DeskStore);
    expect(copied.trayCopyFailed).not.toHaveBeenCalled();

    const store = fakeStore({});
    store.whatsappIntake.mockRejectedValue(new Error('db down'));
    store.trayCopyFailed.mockRejectedValue(new Error('db down'));
    await expect(
      routeDeskDocument(admin, input, store as unknown as DeskStore)
    ).resolves.toMatchObject({ action: 'staff' });
    expect(store.trayCopyFailed).toHaveBeenCalledTimes(2);
  });
});
