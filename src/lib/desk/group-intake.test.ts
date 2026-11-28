import { beforeEach, describe, expect, it, vi } from 'vitest';

// processGroupFile: a file posted in a linked WhatsApp group, through the
// case desk and (optionally) answered in the group. Storage, the gateway
// and the rate limiter are faked at their module boundaries; the desk and
// group-intake stores are fakes of their methods.

const h = vi.hoisted(() => ({
  read: vi.fn(),
  send: vi.fn(),
  limit: vi.fn(),
}));
vi.mock('@/lib/case-files/bytes', () => ({ readDocumentBytes: h.read }));
vi.mock('@/lib/whatsapp/groups', () => ({ sendGroupText: h.send }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: h.limit }));

import { DeskRefusedError } from './store';
import {
  groupItemKeys,
  processGroupFile,
  senderDigits,
  type GroupFileDeps,
} from './group-intake';

const ACCOUNT = 'acct-1';
const GROUP = { id: 'grp-1', wa_group_id: 'x@g.us' };
const REF = { id: 'wamid-1', waGroupId: 'x@g.us' };
const OURS =
  'https://crm.example/storage/v1/object/public/chat-media/account-acct-1/inbound/a.pdf';
const PDF = new TextEncoder().encode('%PDF-1.4 test');

const db = {
  group: { data: GROUP, error: null } as { data: unknown; error: unknown },
  row: { data: null, error: null } as { data: unknown; error: unknown },
  outCount: { count: 0, error: null } as { count: number; error: unknown },
  upserts: [] as Record<string, unknown>[],
};

function messageRow(over: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    direction: 'in',
    sender_wa_id: '971500000001',
    type: 'document',
    body: '4271RAKD ejari',
    media: {
      id: 'm-1',
      link: OURS,
      mime_type: 'application/pdf',
      filename: 'ejari.pdf',
    },
    ...over,
  };
}

const upload = vi.fn();
const admin = {
  rpc: vi.fn(),
  from: (table: string) => {
    const b = {
      select: () => b,
      eq: () => b,
      in: () => b,
      is: () => b,
      gte: async () => db.outCount,
      maybeSingle: async () =>
        table === 'whatsapp_groups' ? db.group : db.row,
      upsert: async (r: Record<string, unknown>) => {
        db.upserts.push(r);
        return { error: null };
      },
    };
    return b;
  },
  storage: { from: () => ({ upload, download: vi.fn() }) },
} as unknown as GroupFileDeps['admin'];

const LINK = {
  bankCode: 'RAK',
  bankName: 'RAKBANK',
  intakeEnabled: true,
  repliesEnabled: true,
};

const groupStore = {
  linkForGroup: vi.fn(),
  staffForPhone: vi.fn(),
  record: vi.fn(),
  claimReply: vi.fn(),
  settleReply: vi.fn(),
};
const desk = {
  bankByShortCode: vi.fn(),
  whatsappIntake: vi.fn(),
};

const deps = (): GroupFileDeps => ({
  admin,
  channel: { id: 'cfg-1', accountId: ACCOUNT },
  loadChannel: () => ({ id: 'cfg-1' }) as never,
  groupStore: groupStore as never,
  desk: desk as never,
});

function result(over: Record<string, unknown> = {}) {
  return {
    itemId: 'item-1',
    state: 'filed',
    caseId: 'case-1',
    caseNumber: 'TC-26-00412-RAK',
    captionCode: '412RAKX',
    fileId: 'file-1',
    duplicateOfItem: null,
    queueBankCode: null,
    queueReason: null,
    replayed: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db.group = { data: GROUP, error: null };
  db.row = { data: messageRow(), error: null };
  db.outCount = { count: 0, error: null };
  db.upserts = [];
  h.read.mockResolvedValue(PDF);
  h.send.mockResolvedValue({ messageId: 'reply-1' });
  h.limit.mockReturnValue({ success: true });
  upload.mockResolvedValue({ error: null });
  groupStore.linkForGroup.mockResolvedValue(LINK);
  groupStore.staffForPhone.mockResolvedValue('staff-1');
  groupStore.record.mockImplementation(async (_a, r) => r.outcome);
  groupStore.claimReply.mockResolvedValue(true);
  groupStore.settleReply.mockResolvedValue(true);
  desk.bankByShortCode.mockResolvedValue(null);
  desk.whatsappIntake.mockResolvedValue(result());
});

const recorded = () => groupStore.record.mock.calls.map((c) => c[1]);

describe('what is looked at', () => {
  it('a group with no link, or intake off, records nothing', async () => {
    groupStore.linkForGroup.mockResolvedValueOnce(null);
    await processGroupFile(deps(), REF);
    groupStore.linkForGroup.mockResolvedValueOnce({
      ...LINK,
      intakeEnabled: false,
      repliesEnabled: false,
    });
    await processGroupFile(deps(), REF);
    expect(groupStore.linkForGroup).toHaveBeenCalledWith(ACCOUNT, 'grp-1');
    expect(groupStore.staffForPhone).not.toHaveBeenCalled();
    expect(groupStore.record).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('our own message and a text are never recorded', async () => {
    db.row = { data: messageRow({ direction: 'out' }), error: null };
    await processGroupFile(deps(), REF);
    db.row = { data: messageRow({ type: 'text', media: null }), error: null };
    await processGroupFile(deps(), REF);
    expect(groupStore.linkForGroup).not.toHaveBeenCalled();
    expect(groupStore.record).not.toHaveBeenCalled();
  });

  it("a submission group's message (no group row of this number) never reaches the desk", async () => {
    db.group = { data: null, error: null };
    await processGroupFile(deps(), REF);
    expect(groupStore.linkForGroup).not.toHaveBeenCalled();
    expect(groupStore.record).not.toHaveBeenCalled();
    expect(desk.whatsappIntake).not.toHaveBeenCalled();
  });

  it('a mirror answers no link, so it is never filed', async () => {
    groupStore.linkForGroup.mockResolvedValue(null);
    await processGroupFile(deps(), REF);
    expect(groupStore.record).not.toHaveBeenCalled();
  });
});

describe('outcomes before the desk', () => {
  it('an unknown or hidden sender is unknown_sender', async () => {
    groupStore.staffForPhone.mockResolvedValueOnce(null);
    await processGroupFile(deps(), REF);
    db.row = {
      data: messageRow({ sender_wa_id: '123456@lid' }),
      error: null,
    };
    await processGroupFile(deps(), REF);
    expect(groupStore.staffForPhone).toHaveBeenCalledTimes(1);
    expect(groupStore.staffForPhone).toHaveBeenCalledWith(
      ACCOUNT,
      '971500000001'
    );
    expect(recorded()).toEqual([
      expect.objectContaining({ outcome: 'unknown_sender', detail: null }),
      expect.objectContaining({ outcome: 'unknown_sender', detail: null }),
    ]);
    expect(desk.whatsappIntake).not.toHaveBeenCalled();
    expect(groupStore.claimReply).not.toHaveBeenCalled();
  });

  it("Whapi's own link (no mirroring) is no_copy, and is never fetched", async () => {
    db.row = {
      data: messageRow({
        media: {
          id: 'm-1',
          link: 'https://s3.whapi.cloud/media/a.pdf',
          mime_type: 'application/pdf',
        },
      }),
      error: null,
    };
    await processGroupFile(deps(), REF);
    expect(h.read).not.toHaveBeenCalled();
    expect(recorded()).toEqual([
      expect.objectContaining({ outcome: 'no_copy', intakeItemId: null }),
    ]);
    expect(groupStore.claimReply).not.toHaveBeenCalled();
  });

  it("another account's chat-media object is not ours either", async () => {
    db.row = {
      data: messageRow({
        media: {
          link: OURS.replace('account-acct-1', 'account-acct-2'),
          mime_type: 'application/pdf',
        },
      }),
      error: null,
    };
    await processGroupFile(deps(), REF);
    expect(h.read).not.toHaveBeenCalled();
    expect(recorded()[0].outcome).toBe('no_copy');
  });

  it('a video is file_type, refused before the download', async () => {
    db.row = {
      data: messageRow({
        type: 'video',
        media: { link: OURS, mime_type: 'video/mp4' },
      }),
      error: null,
    };
    await processGroupFile(deps(), REF);
    expect(h.read).not.toHaveBeenCalled();
    expect(recorded()).toEqual([
      expect.objectContaining({ outcome: 'file_type', detail: 'FILE_INVALID' }),
    ]);
    expect(groupStore.claimReply).not.toHaveBeenCalled();
  });

  it('bytes that are not what the type claims are file_type', async () => {
    h.read.mockResolvedValueOnce(new TextEncoder().encode('not a pdf'));
    await processGroupFile(deps(), REF);
    expect(recorded()[0]).toMatchObject({
      outcome: 'file_type',
      detail: 'FILE_INVALID',
    });
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('through the desk', () => {
  it('filed: stored at the intake path, recorded, answered quoting the file', async () => {
    await processGroupFile(deps(), REF);
    const { itemId, idemKey } = groupItemKeys(ACCOUNT, REF.id);
    const [actor, account, input] = desk.whatsappIntake.mock.calls[0];
    expect([actor, account]).toEqual(['staff-1', ACCOUNT]);
    expect(input.itemId).toBe(itemId);
    expect(input.idemKey).toBe(idemKey);
    expect(input.tags).toMatchObject({
      kind: 'pending_doc',
      caseRef: '4271RAKD',
      docKey: 'ejari',
      bankCode: 'RAK',
    });
    expect(input.file.storagePath).toMatch(
      new RegExp(`^intake/${itemId}/[0-9a-f]{64}\\.pdf$`)
    );
    expect(upload.mock.calls[0][2]).toMatchObject({ upsert: false });
    expect(recorded()).toEqual([
      {
        groupMessageId: 'row-1',
        outcome: 'filed',
        intakeItemId: 'item-1',
        detail: null,
      },
    ]);
    expect(h.send).toHaveBeenCalledWith({
      channel: { id: 'cfg-1' },
      groupId: 'x@g.us',
      text: 'Filed to TC-26-00412-RAK as Ejari.',
      quotedMessageId: 'wamid-1',
    });
    expect(db.upserts).toEqual([
      expect.objectContaining({
        account_id: ACCOUNT,
        group_id: 'grp-1',
        wa_message_id: 'reply-1',
        direction: 'out',
        sender_user_id: null,
        type: 'text',
        status: 'sent',
      }),
    ]);
    expect(groupStore.settleReply).toHaveBeenCalledWith(
      ACCOUNT,
      'row-1',
      true,
      'reply-1'
    );
  });

  it('an object already stored by an earlier run is fine', async () => {
    upload.mockResolvedValueOnce({
      error: { statusCode: '409', message: 'The resource already exists' },
    });
    await processGroupFile(deps(), REF);
    expect(recorded()[0].outcome).toBe('filed');
  });

  it("a caption naming no bank takes the link's bank", async () => {
    db.row = { data: messageRow({ body: 'see attached' }), error: null };
    desk.whatsappIntake.mockResolvedValueOnce(
      result({
        state: 'untagged',
        queueBankCode: 'RAK',
        queueReason: 'NO_KIND',
      })
    );
    await processGroupFile(deps(), REF);
    expect(desk.whatsappIntake.mock.calls[0][2].tags).toMatchObject({
      kind: null,
      bankCode: 'RAK',
      note: 'see attached',
    });
    expect(recorded()[0]).toMatchObject({
      outcome: 'queued',
      detail: 'NO_KIND',
    });
    expect(h.send.mock.calls[0][0].text).toBe(
      'Sent to the RAKBANK sorting queue: the caption does not say what the file is.'
    );
  });

  it('a queue with no bank, or another bank, reads "the sorting queue"', async () => {
    for (const queueBankCode of [null, 'ENBD']) {
      h.send.mockClear();
      db.row = { data: messageRow({ body: 'see attached' }), error: null };
      desk.whatsappIntake.mockResolvedValueOnce(
        result({ state: 'untagged', queueBankCode, queueReason: 'NO_KIND' })
      );
      await processGroupFile(deps(), REF);
      expect(h.send.mock.calls[0][0].text).toBe(
        'Sent to the sorting queue: the caption does not say what the file is.'
      );
    }
  });

  it('a retry after no_copy files, and the stored outcome becomes the filed one', async () => {
    db.row = {
      data: messageRow({
        media: {
          link: 'https://s3.whapi.cloud/media/a.pdf',
          mime_type: 'application/pdf',
        },
      }),
      error: null,
    };
    await processGroupFile(deps(), REF);
    expect(recorded()[0].outcome).toBe('no_copy');
    expect(groupStore.claimReply).not.toHaveBeenCalled();

    // the copy has arrived: 324 lets the item supersede the no_copy row
    db.row = { data: messageRow(), error: null };
    groupStore.record.mockClear();
    await processGroupFile(deps(), REF);
    expect(groupStore.record).toHaveBeenCalledWith(
      ACCOUNT,
      expect.objectContaining({ outcome: 'filed', intakeItemId: 'item-1' })
    );
    expect(groupStore.claimReply).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("a NEW caption's desk code wins over the link's bank: new_case", async () => {
    db.row = {
      data: messageRow({ body: 'NEW ENB Acme Trading 12345' }),
      error: null,
    };
    desk.bankByShortCode.mockResolvedValueOnce('ENBD');
    desk.whatsappIntake.mockResolvedValueOnce(
      result({ caseNumber: 'TC-26-00431-ENB', captionCode: '431ENB5' })
    );
    await processGroupFile(deps(), REF);
    expect(desk.bankByShortCode).toHaveBeenCalledWith(ACCOUNT, 'ENB');
    expect(desk.whatsappIntake.mock.calls[0][2].tags).toMatchObject({
      kind: 'new_case',
      bankCode: 'ENBD',
    });
    expect(recorded()[0].outcome).toBe('new_case');
    expect(h.send.mock.calls[0][0].text).toBe(
      'New case TC-26-00431-ENB opened. Caption code 431ENB5'
    );
  });

  it('duplicate', async () => {
    desk.whatsappIntake.mockResolvedValueOnce(
      result({ state: 'duplicate', duplicateOfItem: 'item-0' })
    );
    await processGroupFile(deps(), REF);
    expect(recorded()[0]).toMatchObject({
      outcome: 'duplicate',
      intakeItemId: 'item-1',
    });
    expect(h.send.mock.calls[0][0].text).toBe(
      'Already on this case - nothing more to do.'
    );
  });

  it('a desk refusal is refused, with the hint as its detail', async () => {
    desk.whatsappIntake.mockRejectedValueOnce(
      new DeskRefusedError('NOT_ALLOWED')
    );
    await processGroupFile(deps(), REF);
    expect(recorded()).toEqual([
      {
        groupMessageId: 'row-1',
        outcome: 'refused',
        intakeItemId: null,
        detail: 'NOT_ALLOWED',
      },
    ]);
    expect(h.send.mock.calls[0][0].text).toBe(
      'Could not file: your login cannot upload to the case desk.'
    );
  });

  it('a queue reason that is no code is stored as OTHER', async () => {
    desk.whatsappIntake.mockResolvedValueOnce(
      result({ state: 'untagged', queueReason: 'not a code!' })
    );
    await processGroupFile(deps(), REF);
    expect(recorded()[0].detail).toBe('OTHER');
  });
});

describe('the item id', () => {
  it('the same message twice: the same item id and idempotency key', async () => {
    await processGroupFile(deps(), REF);
    await processGroupFile(deps(), REF);
    const [a, b] = desk.whatsappIntake.mock.calls.map((c) => c[2]);
    expect(a.itemId).toBe(b.itemId);
    expect(a.idemKey).toBe(b.idemKey);
    expect(a.itemId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(a.idemKey).toMatch(/^grp:[0-9a-f]{40}$/);
  });

  it('differs by account and by message', () => {
    const k = groupItemKeys('acct-1', 'wamid-1');
    expect(groupItemKeys('acct-1', 'wamid-1')).toEqual(k);
    expect(groupItemKeys('acct-2', 'wamid-1').itemId).not.toBe(k.itemId);
    expect(groupItemKeys('acct-1', 'wamid-2').itemId).not.toBe(k.itemId);
  });

  it('sender digits', () => {
    expect(senderDigits('+971 50 000 0001')).toBe('971500000001');
    expect(senderDigits('971500000001@s.whatsapp.net')).toBe('971500000001');
    expect(senderDigits('123@lid')).toBe('');
    expect(senderDigits(null)).toBe('');
  });
});

describe('replies', () => {
  it('are sent once even when the message is processed twice', async () => {
    groupStore.claimReply
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await processGroupFile(deps(), REF);
    await processGroupFile(deps(), REF);
    expect(groupStore.claimReply).toHaveBeenCalledTimes(2);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('with replies off the claim is refused and nothing is sent', async () => {
    groupStore.claimReply.mockResolvedValue(false);
    await processGroupFile(deps(), REF);
    expect(recorded()[0].outcome).toBe('filed');
    expect(h.send).not.toHaveBeenCalled();
    expect(groupStore.settleReply).not.toHaveBeenCalled();
  });

  it("a replay (another number's or an earlier run's item) is not answered", async () => {
    desk.whatsappIntake.mockResolvedValueOnce(result({ replayed: true }));
    await processGroupFile(deps(), REF);
    expect(recorded()[0].outcome).toBe('filed');
    expect(groupStore.claimReply).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a stored outcome from another run wins, and that run answers', async () => {
    groupStore.record.mockResolvedValueOnce('queued');
    await processGroupFile(deps(), REF);
    expect(groupStore.claimReply).not.toHaveBeenCalled();
  });

  it('over the group budget: settled failed, nothing sent', async () => {
    db.outCount = { count: 20, error: null };
    await processGroupFile(deps(), REF);
    h.limit.mockReturnValueOnce({ success: false });
    db.outCount = { count: 0, error: null };
    await processGroupFile(deps(), REF);
    expect(h.limit).toHaveBeenCalledWith('group-send:grp-1', {
      limit: 20,
      windowMs: 60_000,
    });
    expect(h.send).not.toHaveBeenCalled();
    expect(groupStore.settleReply.mock.calls).toEqual([
      [ACCOUNT, 'row-1', false, null],
      [ACCOUNT, 'row-1', false, null],
    ]);
  });

  it('a failed send is settled failed, and no row is written', async () => {
    h.send.mockRejectedValueOnce(new Error('gateway down 971500000001'));
    await processGroupFile(deps(), REF);
    expect(groupStore.settleReply).toHaveBeenCalledWith(
      ACCOUNT,
      'row-1',
      false,
      null
    );
    expect(db.upserts).toEqual([]);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      '9715'
    );
  });
});

describe('never throws', () => {
  it('a thrown storage error stays inside, logging no phone or link', async () => {
    upload.mockRejectedValueOnce(new Error('socket 971500000001 ' + OURS));
    await expect(processGroupFile(deps(), REF)).resolves.toBeUndefined();
    expect(groupStore.record).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain('row-1');
    expect(logged).not.toMatch(/9715|chat-media/);
  });

  it('a failed read of the group or the links stays inside', async () => {
    db.group = { data: null, error: { code: '57014' } };
    await expect(processGroupFile(deps(), REF)).resolves.toBeUndefined();
    db.group = { data: GROUP, error: null };
    groupStore.linkForGroup.mockRejectedValueOnce(new Error('boom'));
    await expect(processGroupFile(deps(), REF)).resolves.toBeUndefined();
    expect(groupStore.record).not.toHaveBeenCalled();
  });
});
