import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  setCached: vi.fn(),
  available: vi.fn(() => true),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/insights/settings', () => ({
  insightsAvailable: mocks.available,
  setCachedInsightSettings: mocks.setCached,
}));

import { GET, PUT } from './route';

const SAVED_AT = '2026-10-29T08:00:00.000000+00:00';
const TAG = '6f1c2a34-1b2c-4d5e-8f90-123456789abc';

const row = (extra: Record<string, unknown> = {}) => ({
  account_id: 'account-1',
  signals_enabled: false,
  tag_suggest_mode: 'off',
  tag_auto_min_p: 0.85,
  reply_class_enabled: false,
  reply_interested_tag_id: null,
  compose_check_mode: 'off',
  meaning_triggers_enabled: false,
  kb_gap_judge_enabled: false,
  updated_at: SAVED_AT,
  updated_by: null,
  ...extra,
});

/** A PostgREST stand-in for ai_insight_settings; records writes and filters. */
function fakeDb(
  settings: Record<string, unknown> | null,
  writeError: { code: string; message: string } | null = null
) {
  const writes: { op: string; values: Record<string, unknown> }[] = [];
  const filters: [string, unknown][] = [];
  let saved = settings;
  const from = () => {
    let writing = false;
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (col: string, v: unknown) => {
      filters.push([col, v]);
      return b;
    };
    const write = (op: string) => (values: Record<string, unknown>) => {
      writing = true;
      writes.push({ op, values });
      if (!writeError)
        saved = { ...(saved ?? row()), ...values, updated_at: 'next' };
      return b;
    };
    b.update = write('update');
    b.insert = write('insert');
    b.maybeSingle = async () =>
      writing && writeError
        ? { data: null, error: writeError }
        : { data: saved, error: null };
    return b;
  };
  return { db: { from }, writes, filters };
}

let db: ReturnType<typeof fakeDb>;
function useDb(
  settings: Record<string, unknown> | null,
  role = 'admin',
  writeError: { code: string; message: string } | null = null
) {
  db = fakeDb(settings, writeError);
  mocks.requireRole.mockResolvedValue({
    supabase: db.db,
    accountId: 'account-1',
    userId: 'user-1',
    role,
  });
}

const values = {
  signalsEnabled: true,
  tagSuggestMode: 'auto',
  tagAutoMinP: 0.9,
  replyClassEnabled: true,
  replyInterestedTagId: TAG,
  composeCheckMode: 'warn',
  meaningTriggersEnabled: true,
  kbGapJudgeEnabled: true,
  attentionPinUrgent: true,
  attentionPinUpset: false,
  attentionPinWantsPerson: true,
  attentionPinCallback: false,
  attentionNotify: false,
  reminderSuggestEnabled: true,
};

function put(body: unknown) {
  return PUT(
    new Request('http://localhost/api/insights/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.setCached.mockReset();
  mocks.available.mockReturnValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  useDb(row());
});

describe('GET /api/insights/settings', () => {
  it('answers any staff member, with canEdit by role', async () => {
    useDb(row({ signals_enabled: true }), 'agent');
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(mocks.requireRole).toHaveBeenCalledWith('viewer');
    expect(json.settings.signalsEnabled).toBe(true);
    expect(json.available).toBe(true);
    expect(json.canEdit).toBe(false);
  });

  it('reads no row as everything off, and reports unavailability', async () => {
    useDb(null);
    mocks.available.mockReturnValue(false);
    const json = await (await GET()).json();
    expect(json.settings.tagSuggestMode).toBe('off');
    expect(json.settings.updatedAt).toBeNull();
    expect(json.available).toBe(false);
    expect(json.canEdit).toBe(true);
  });

  it('answers the auth error to a bank guest', async () => {
    mocks.requireRole.mockRejectedValue(new Error('guest'));
    expect((await GET()).status).toBe(403);
  });
});

describe('PUT /api/insights/settings', () => {
  it('requires an admin', async () => {
    mocks.requireRole.mockRejectedValue(new Error('agent'));
    expect((await put({ ...values, expectedUpdatedAt: SAVED_AT })).status).toBe(
      403
    );
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
  });

  it('refuses an invalid body with a 400 { error }', async () => {
    const res = await put({
      ...values,
      tagAutoMinP: 2,
      expectedUpdatedAt: null,
    });
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe('string');
    expect(db.writes).toEqual([]);
  });

  it('saves against the version shown and writes through to the cache', async () => {
    const res = await put({ ...values, expectedUpdatedAt: SAVED_AT });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0].op).toBe('update');
    expect(db.writes[0].values).toMatchObject({
      tag_suggest_mode: 'auto',
      reply_interested_tag_id: TAG,
      attention_pin_upset: false,
      attention_notify: false,
      reminder_suggest_enabled: true,
      updated_by: 'user-1',
    });
    expect(db.filters).toContainEqual(['updated_at', SAVED_AT]);
    expect(json.settings).toMatchObject({ ...values, updatedAt: 'next' });
    expect(mocks.setCached).toHaveBeenCalledWith('account-1', json.settings);
  });

  it('answers 409 and writes nothing when the version moved', async () => {
    const res = await put({ ...values, expectedUpdatedAt: 'older' });
    expect(res.status).toBe(409);
    expect(db.writes).toEqual([]);
    expect(mocks.setCached).not.toHaveBeenCalled();
  });

  it('inserts the first save when nothing was saved and none expected', async () => {
    useDb(null);
    const res = await put({ ...values, expectedUpdatedAt: null });
    expect(res.status).toBe(200);
    expect(db.writes[0].op).toBe('insert');
  });

  it('answers 409 to a first save when a row now exists', async () => {
    const res = await put({ ...values, expectedUpdatedAt: null });
    expect(res.status).toBe(409);
  });

  it('answers 409 when a racing first insert hits the primary key', async () => {
    useDb(null, 'admin', { code: '23505', message: 'duplicate' });
    const res = await put({ ...values, expectedUpdatedAt: null });
    expect(res.status).toBe(409);
  });

  it('answers 400 when the tag is a sub-tag or another account’s', async () => {
    useDb(row(), 'admin', { code: '23514', message: 'sub-tag' });
    const res = await put({ ...values, expectedUpdatedAt: SAVED_AT });
    expect(res.status).toBe(400);
    expect(mocks.setCached).not.toHaveBeenCalled();
  });
});
