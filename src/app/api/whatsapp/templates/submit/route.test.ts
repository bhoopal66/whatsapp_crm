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

async function submit(template_id?: string) {
  const res = await POST(
    new Request('http://x/api/whatsapp/templates/submit', {
      method: 'POST',
      body: JSON.stringify({
        name: 'welcome',
        category: 'Utility',
        language: 'en',
        body_text: 'New text',
        footer_text: 'Bye',
        template_id,
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

describe('templates submit: Meta did not refuse the template', () => {
  const duplicate = new MetaError('Invalid parameter', 400, 100, 2388024);

  it.each<[string, unknown, number, string]>([
    ['Meta already has it', duplicate, 409, 'META_HAS_IT'],
    ['a timeout', new MetaError('no respond', 504), 502, 'META_NO_ANSWER'],
    ['a 5xx', new MetaError('Oops', 500, 1), 502, 'META_NO_ANSWER'],
    ['Meta is down', new MetaError('Later', 400, 2), 502, 'META_NO_ANSWER'],
    ['no connection', new TypeError('fetch failed'), 502, 'META_NO_ANSWER'],
    ['no id in the answer', new Error('no id'), 502, 'META_NO_ANSWER'],
  ])('stores nothing: %s', async (_, err, code, name) => {
    mocks.submit.mockRejectedValue(err);
    const created = await submit();
    expect(created.status).toBe(code);
    expect(created.body.code).toBe(name);
    expect(rows()).toEqual([]);

    rows().push(row({ status: 'DRAFT' }));
    const before = structuredClone(rows());
    expect((await submit('row-1')).status).toBe(code);
    expect(rows()).toEqual(before);
    expect(mocks.db.writes ?? []).toEqual([]);
  });

  it('says what to do', async () => {
    mocks.submit.mockRejectedValueOnce(duplicate);
    expect((await submit()).body.error).toBe(
      'Meta already has a template with this name and language. Press Sync.'
    );
    mocks.submit.mockRejectedValueOnce(new MetaError('x', 503));
    expect((await submit()).body.error).toBe(
      'Meta did not answer. It may have been submitted; press Sync in a minute.'
    );
  });

  it.each([
    ['an expired token', new MetaError('Expired', 401, 190)],
    ['a missing permission', new MetaError('Permission', 403, 200)],
    ['the rate limit', new MetaError('Too many', 400, 80007)],
  ])('is saved without a refusal: %s', async (_, err) => {
    mocks.submit.mockRejectedValue(err);
    const { status, body } = await submit();
    expect(status).toBe(200);
    expect(body.meta).toEqual({
      submitted: false,
      reason: 'meta_unavailable',
    });
    expect(rows()).toHaveLength(1);
    expect(rows()[0].submission_error).toBeUndefined();
  });

  it.each([
    ['an unknown subcode', new MetaError('Bad', 400, 100, 2388299)],
    ['one being deleted', new MetaError('Bad', 400, 100, 2388023)],
    ['a policy block', new MetaError('Bad', 400, 368)],
  ])('keeps a refusal: %s', async (_, err) => {
    mocks.submit.mockRejectedValue(err);
    expect((await submit()).body.meta.error).toBe('Bad');
    expect(rows()[0].submission_error).toBe('Bad');
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

describe('templates submit: a saved row sent to Meta', () => {
  const theirs = (over: Record<string, unknown> = {}) =>
    row({ id: 'row-2', user_id: 'b', ...over });

  it('updates the row named, not the caller’s own of that name', async () => {
    rows().push(row(), theirs());
    const { status, body } = await submit('row-2');
    expect(status).toBe(200);
    expect(body.template).toMatchObject({ id: 'row-2' });
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toEqual(row());
    expect(rows()[1]).toMatchObject({
      user_id: 'b',
      meta_template_id: 'M1',
      status: 'PENDING',
    });
  });

  it('keeps the id on the row named when the first write fails', async () => {
    rows().push(row(), theirs());
    failOnce('update', { message: 'timeout' });
    expect((await submit('row-2')).body.code).toBe('META_ACCEPTED_NOT_SAVED');
    expect(rows()[0]).toEqual(row());
    expect(rows()[1]).toMatchObject({ user_id: 'b', meta_template_id: 'M1' });
  });

  it.each([
    ['of another account', theirs({ account_id: 'acct-2' })],
    ['of another name', theirs({ name: 'bye' })],
    ['of another language', theirs({ language: 'ar' })],
    ['that is gone', theirs({ id: 'row-3' })],
  ])('refuses a row %s before Meta is asked', async (_, other) => {
    rows().push(row(), other);
    const before = structuredClone(rows());
    const { status, body } = await submit('row-2');
    expect(status).toBe(404);
    expect(body.code).toBe('TEMPLATE_GONE');
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(rows()).toEqual(before);
  });

  it('refuses one whose name is Meta’s through a teammate', async () => {
    rows().push(row(), theirs({ meta_template_id: 'M0' }));
    expect((await submit('row-1')).body.code).toBe('TEMPLATE_EXISTS');
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('leaves a draft a draft when Meta did not take it', async () => {
    rows().push(row({ status: 'DRAFT' }));
    mocks.submit.mockRejectedValue(new MetaError('Bad footer', 400));
    await submit('row-1');
    expect(rows()[0]).toMatchObject({
      status: 'DRAFT',
      submission_error: 'Bad footer',
    });
    mocks.channels.mockResolvedValue([]);
    await submit('row-1');
    expect(rows()[0]).toMatchObject({ status: 'DRAFT' });
  });

  it('without an id saves the caller’s own row, approved, as before', async () => {
    rows().push(theirs(), row({ status: 'DRAFT' }));
    mocks.submit.mockRejectedValue(new MetaError('Bad footer', 400));
    await submit();
    expect(rows()[0]).toEqual(theirs());
    expect(rows()[1]).toMatchObject({
      status: 'APPROVED',
      submission_error: 'Bad footer',
    });
  });
});
