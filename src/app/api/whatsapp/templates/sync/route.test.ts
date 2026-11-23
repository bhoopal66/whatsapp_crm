import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, type FakeDb } from '@/lib/groups/test-db';

// A template deleted at Meta stayed APPROVED here until its webhook came,
// and for good when it never did. Sync now disables what Meta no longer
// lists, and only when the list proves it: whole, not empty, and from the
// account's one WABA.

const mocks = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  channels: [] as unknown[],
  list: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  assertSalesAccess: (x: unknown) => x,
  requireRole: async () => ({
    supabase: fakeSupabase(mocks.db),
    accountId: 'acct-1',
    userId: 'admin-1',
  }),
  toErrorResponse: (err: unknown) => {
    throw err;
  },
}));
vi.mock('@/lib/whatsapp/channels', () => ({
  loadChannels: async () => mocks.channels,
}));
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()),
  listMessageTemplates: mocks.list,
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';

import { POST } from './route';

const remote = (id: string, name = `t-${id}`, body: string | null = 'Hi') => ({
  id,
  name,
  language: 'en',
  status: 'APPROVED',
  category: 'UTILITY',
  components: body ? [{ type: 'BODY', text: body }] : [],
});
const local = (id: string, over: Record<string, unknown> = {}) => ({
  id: `row-${id}`,
  account_id: 'acct-1',
  name: `t-${id}`,
  language: 'en',
  meta_template_id: id,
  status: 'APPROVED',
  ...over,
});
const metaRow = (over: Record<string, unknown> = {}) => ({
  account_id: 'acct-1',
  provider: 'meta',
  waba_id: 'waba-1',
  ...over,
});

const answer = (templates: unknown[], complete = true) =>
  mocks.list.mockResolvedValue({ templates, complete });
const sync = async () => (await POST()).json();
const status = (id: string) =>
  mocks.db.tables.message_templates.find((r) => r.id === `row-${id}`)?.status;

beforeEach(() => {
  __resetRateLimitForTests();
  mocks.list.mockReset();
  mocks.channels = [
    { id: 'ch-1', provider: 'meta', wabaId: 'waba-1', accessToken: 't' },
  ];
  mocks.db = {
    tables: {
      message_templates: [local('1'), local('2')],
      whatsapp_config: [metaRow()],
    },
  };
});

describe('templates sync: what Meta no longer has', () => {
  it('disables a missing template and counts it', async () => {
    answer([remote('1')]);
    expect(await sync()).toEqual({
      success: true,
      total: 1,
      created: 0,
      updated: 1,
      skipped: 0,
      disabled: 1,
    });
    expect(status('1')).toBe('APPROVED');
    expect(status('2')).toBe('DISABLED');
    // Nothing left to disable: the next sync says so.
    expect((await sync()).disabled).toBe(0);
  });

  it('leaves a draft and another account alone', async () => {
    mocks.db.tables.message_templates.push(
      local('3', { meta_template_id: null, status: 'DRAFT' }),
      local('4', { account_id: 'acct-2' })
    );
    answer([remote('1'), remote('2')]);
    expect((await sync()).disabled).toBe(0);
    expect(status('3')).toBe('DRAFT');
    expect(status('4')).toBe('APPROVED');
  });

  it('keeps the stored status when Meta names one we do not know', async () => {
    answer([
      { ...remote('1'), status: 'LIMIT_EXCEEDED' },
      remote('2'),
      { ...remote('9'), status: 'LIMIT_EXCEEDED' },
    ]);
    await sync();
    expect(status('1')).toBe('APPROVED');
    // A new one is not offered to any sender.
    expect(
      mocks.db.tables.message_templates.find((r) => r.meta_template_id === '9')
        ?.status
    ).toBe('PENDING');
  });

  it('leaves one still waiting for Meta alone: the list may not have it yet', async () => {
    mocks.db.tables.message_templates.push(local('5', { status: 'PENDING' }));
    answer([remote('1'), remote('2')]);
    expect((await sync()).disabled).toBe(0);
    expect(status('5')).toBe('PENDING');
  });

  it('counts a body-less template Meta still lists as present', async () => {
    answer([remote('1'), remote('2', 't-2', null)]);
    expect(await sync()).toMatchObject({ skipped: 1, disabled: 0 });
    expect(status('2')).toBe('APPROVED');
  });

  it('keeps a row adopted under a new id', async () => {
    answer([remote('1'), remote('22', 't-2')]);
    expect(await sync()).toMatchObject({ updated: 2, disabled: 0 });
    expect(status('2')).toBe('APPROVED');
  });

  it.each([
    ['empty', [], true],
    ['incomplete', [remote('1')], false],
  ])('does nothing on an %s list', async (_, templates, complete) => {
    answer(templates, complete);
    expect((await sync()).disabled).toBe(0);
    expect(status('2')).toBe('APPROVED');
  });

  // loadChannels leaves out a number it cannot decrypt; its WABA counts.
  it.each([
    ['another WABA', 'waba-2'],
    ['an unknown WABA', null],
  ])('does nothing when a Meta number has %s', async (_, waba_id) => {
    mocks.db.tables.whatsapp_config.push(metaRow({ waba_id }));
    answer([remote('1')]);
    expect((await sync()).disabled).toBe(0);
    expect(status('2')).toBe('APPROVED');
  });

  it("looks past a second number on the WABA, Whapi and other accounts'", async () => {
    mocks.db.tables.whatsapp_config.push(
      metaRow(),
      metaRow({ provider: 'whapi', waba_id: '971500000000' }),
      metaRow({ account_id: 'acct-2', waba_id: 'waba-9' })
    );
    answer([remote('1')]);
    expect((await sync()).disabled).toBe(1);
  });

  it('spares a template submitted while Meta was being read', async () => {
    mocks.list.mockImplementation(async () => {
      mocks.db.tables.message_templates.push(local('5'));
      // Deleted and submitted again: the same row, a new id.
      mocks.db.tables.message_templates[1] = local('2', {
        meta_template_id: '222',
        status: 'PENDING',
      });
      return { templates: [remote('1')], complete: true };
    });
    expect((await sync()).disabled).toBe(0);
    expect(status('5')).toBe('APPROVED');
    expect(status('2')).toBe('PENDING');
  });

  it('matches a row added meanwhile instead of inserting it twice', async () => {
    mocks.list.mockImplementation(async () => {
      mocks.db.tables.message_templates.push(local('5'));
      return {
        templates: [remote('1'), remote('2'), remote('5')],
        complete: true,
      };
    });
    expect(await sync()).toMatchObject({ created: 0, updated: 3 });
  });
});
