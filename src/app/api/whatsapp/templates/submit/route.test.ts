import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, type FakeDb } from '@/lib/groups/test-db';

// A "new" template under the name of one Meta already has dropped its
// Meta id and showed it APPROVED; Meta then refused the duplicate, so no
// Meta chat could send it until the next Sync.

const mocks = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  channels: vi.fn(),
  submit: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  assertSalesAccess: (x: unknown) => x,
  requireRole: async () => ({
    supabase: fakeSupabase(mocks.db),
    accountId: 'acct-1',
    userId: 'admin-1',
  }),
  ForbiddenError: class extends Error {},
  UnauthorizedError: class extends Error {},
  toErrorResponse: (err: unknown) => {
    throw err;
  },
}));
vi.mock('@/lib/whatsapp/channels', () => ({ loadChannels: mocks.channels }));
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()),
  submitMessageTemplate: mocks.submit,
}));

import { MetaError } from '@/lib/whatsapp/meta-api';

import { POST } from './route';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'row-1',
  account_id: 'acct-1',
  user_id: 'admin-1',
  name: 'welcome',
  language: 'en',
  body_text: 'Old',
  status: 'APPROVED',
  meta_template_id: null,
  submission_error: null,
  ...over,
});

async function submit() {
  const res = await POST(
    new Request('http://x/api/whatsapp/templates/submit', {
      method: 'POST',
      body: JSON.stringify({
        name: 'welcome',
        category: 'Utility',
        language: 'en',
        body_text: 'New text',
        footer_text: 'Bye',
      }),
    })
  );
  return { status: res.status, body: await res.json() };
}
const rows = () => mocks.db.tables.message_templates;
/** The first `table:op` fails, the next ones work. */
function failOnce(op: string, error: unknown) {
  let left = 1;
  mocks.db.errors = {};
  Object.defineProperty(mocks.db.errors, `message_templates:${op}`, {
    get: () => (left-- > 0 ? error : undefined),
  });
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.channels
    .mockReset()
    .mockResolvedValue([
      { id: 'ch-1', provider: 'meta', wabaId: 'waba-1', accessToken: 't' },
    ]);
  mocks.submit.mockReset().mockResolvedValue({ id: 'M1', status: 'PENDING' });
  mocks.db = {
    tables: { message_templates: [] },
    unique: { message_templates: ['user_id', 'name', 'language'] },
  };
});

describe('templates submit: a name Meta already has', () => {
  it.each([
    ['a Meta id', { meta_template_id: 'M0' }],
    ["a teammate's Meta id", { user_id: 'b', meta_template_id: 'M0' }],
    ['a Meta status', { status: 'REJECTED' }],
    ['one waiting', { status: 'PENDING' }],
  ])('refuses it before anything is written: %s', async (_, over) => {
    rows().push(row(over));
    const before = structuredClone(rows());

    const { status, body } = await submit();

    expect(status).toBe(409);
    expect(body).toEqual({
      error:
        'A template with this name and language already exists. Edit it, or choose another name.',
      code: 'TEMPLATE_EXISTS',
    });
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.db.writes ?? []).toEqual([]);
    expect(rows()).toEqual(before);
  });

  it.each([
    ['another account', { account_id: 'acct-2', user_id: 'b' }],
    ['another language', { language: 'ar' }],
  ])('is not stopped by %s', async (_, over) => {
    rows().push(row({ meta_template_id: 'M0', ...over }));
    expect((await submit()).status).toBe(200);
    expect(rows()[0]).toMatchObject({ meta_template_id: 'M0' });
    expect(rows()[1]).toMatchObject({ meta_template_id: 'M1' });
  });

  it('lets a local row be submitted again, on the same row', async () => {
    rows().push(row());
    const { status, body } = await submit();
    expect(status).toBe(200);
    expect(body.meta).toEqual({ submitted: true, status: 'PENDING' });
    expect(body.template).toMatchObject({ id: 'row-1' });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      body_text: 'New text',
      footer_text: 'Bye',
      meta_template_id: 'M1',
      status: 'PENDING',
    });
  });
});

describe('templates submit: the order of things', () => {
  it('keeps a refusal until Meta answers, and writes once', async () => {
    rows().push(row({ submission_error: 'Bad header' }));
    mocks.submit.mockImplementation(async () => {
      expect(rows()[0]).toMatchObject({
        submission_error: 'Bad header',
        body_text: 'Old',
      });
      return { id: 'M1', status: 'APPROVED' };
    });
    await submit();
    expect(mocks.db.writes).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      submission_error: null,
      meta_template_id: 'M1',
    });
  });

  it.each([
    [
      'the numbers cannot be read',
      'meta_unavailable',
      () => Promise.reject(new Error('down')),
    ],
    [
      'the Meta number has no business account',
      'meta_unavailable',
      () => Promise.resolve([{ id: 'ch-1', provider: 'meta', wabaId: null }]),
    ],
    [
      'no Meta number is connected',
      'no_meta_number',
      () => Promise.resolve([{ id: 'ch-2', provider: 'whapi' }]),
    ],
  ])('keeps it when Meta was not asked: %s', async (_, reason, load) => {
    mocks.channels.mockImplementation(load);
    rows().push(row({ submission_error: 'Bad header' }));
    const { status, body } = await submit();
    expect(status).toBe(200);
    expect(body.meta).toEqual({ submitted: false, reason });
    expect(rows()[0]).toMatchObject({
      submission_error: 'Bad header',
      body_text: 'New text',
    });
  });

  it('saves a template Meta refuses, with the reason', async () => {
    mocks.submit.mockRejectedValue(new MetaError('Bad footer', 400));
    const { status, body } = await submit();
    expect(status).toBe(200);
    expect(body.meta).toEqual({ submitted: false, error: 'Bad footer' });
    expect(rows()[0]).toMatchObject({
      status: 'APPROVED',
      submission_error: 'Bad footer',
    });
    expect(rows()[0].meta_template_id).toBeUndefined();
  });

  it('never writes a refusal over a row that became Meta’s meanwhile', async () => {
    rows().push(row());
    mocks.submit.mockImplementation(async () => {
      Object.assign(rows()[0], { meta_template_id: 'M9', status: 'PENDING' });
      throw new MetaError('Name exists', 400);
    });
    const { status } = await submit();
    expect(status).toBe(409);
    expect(rows()[0]).toMatchObject({
      meta_template_id: 'M9',
      status: 'PENDING',
      submission_error: null,
    });
  });

  it('answers 409 when the same name was saved meanwhile', async () => {
    mocks.submit.mockImplementation(async () => {
      rows().push(row({ meta_template_id: 'M9' }));
      throw new MetaError('Name exists', 400);
    });
    expect((await submit()).status).toBe(409);
    expect(rows()).toHaveLength(1);
  });
});

describe('templates submit: Meta took it and the write failed', () => {
  it.each([
    ['insert', []],
    ['update', [row()]],
  ])('the id is saved all the same (%s)', async (op, start) => {
    rows().push(...start);
    failOnce(op, { message: 'timeout' });
    const { status, body } = await submit();
    expect(status).toBe(500);
    expect(body.code).toBe('META_ACCEPTED_NOT_SAVED');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      body_text: 'New text',
      meta_template_id: 'M1',
      status: 'PENDING',
    });
  });

  it('also on a row saved meanwhile under the same name', async () => {
    mocks.submit.mockImplementation(async () => {
      rows().push(row({ submission_error: 'Name exists' }));
      return { id: 'M1', status: 'PENDING' };
    });
    expect((await submit()).status).toBe(500);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      meta_template_id: 'M1',
      submission_error: null,
    });
  });

  it('a status the column does not allow does not lose the id', async () => {
    mocks.submit.mockResolvedValue({ id: 'M1', status: 'LIMIT_EXCEEDED' });
    expect((await submit()).status).toBe(200);
    expect(rows()[0]).toMatchObject({
      meta_template_id: 'M1',
      status: 'PENDING',
    });
  });
});
