import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  requireRole: vi.fn(),
  loadDealRoomSettings: vi.fn(),
  inviteTemplateStatus: vi.fn(),
  metaChannel: vi.fn(),
  upsert: vi.fn(),
  from: vi.fn(),
  admin: { service: true },
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: m.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => m.admin,
}));
// The real input parser, stubbed reads.
vi.mock('@/lib/deal-rooms/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/deal-rooms/settings')>()),
  loadDealRoomSettings: m.loadDealRoomSettings,
  inviteTemplateStatus: m.inviteTemplateStatus,
}));
vi.mock('@/lib/deal-rooms/shared', () => ({ metaChannel: m.metaChannel }));

import { GET, PUT } from './route';

const CTX = {
  supabase: { from: m.from },
  accountId: 'acct-1',
  userId: 'user-1',
  role: 'admin',
};

const SAVED = {
  inviteTemplateName: 'group_invite',
  inviteTemplateLanguage: 'en_US',
  inviteTemplateNameAr: 'group_invite_ar',
  updatedAt: '2026-10-12T09:00:00Z',
};

const status = (name: string, language: string) => ({
  name,
  language,
  found: true,
  status: 'APPROVED',
  ready: true,
});

const put = (body: unknown) =>
  PUT(
    new Request('http://localhost/api/deal-rooms/settings', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.requireRole.mockResolvedValue(CTX);
  m.loadDealRoomSettings.mockResolvedValue(SAVED);
  m.inviteTemplateStatus.mockImplementation(
    async (_db: unknown, _acct: string, name: string, language: string) =>
      status(name, language)
  );
  m.metaChannel.mockResolvedValue({ id: 'cfg-1', provider: 'meta' });
  m.upsert.mockResolvedValue({ error: null });
  m.from.mockReturnValue({ upsert: m.upsert });
});

describe('GET /api/deal-rooms/settings', () => {
  it('answers the saved settings, the Meta number and both template copies', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      settings: SAVED,
      metaNumber: true,
      template: status('group_invite', 'en_US'),
      templateAr: status('group_invite_ar', 'ar'),
    });
    expect(m.requireRole).toHaveBeenCalledWith('admin');
    expect(m.loadDealRoomSettings).toHaveBeenCalledWith(CTX.supabase, 'acct-1');
    // Template status on the service role, scoped to the account.
    expect(m.inviteTemplateStatus).toHaveBeenCalledWith(
      m.admin,
      'acct-1',
      'group_invite_ar',
      'ar'
    );
    expect(m.metaChannel).toHaveBeenCalledWith(m.admin, 'acct-1');
  });

  it('answers null template statuses and no Meta number when none is set', async () => {
    m.loadDealRoomSettings.mockResolvedValue({
      ...SAVED,
      inviteTemplateName: null,
      inviteTemplateNameAr: null,
    });
    m.metaChannel.mockResolvedValue(null);
    expect(await (await GET()).json()).toMatchObject({
      metaNumber: false,
      template: null,
      templateAr: null,
    });
    expect(m.inviteTemplateStatus).not.toHaveBeenCalled();
  });

  it('is for admins only', async () => {
    m.requireRole.mockRejectedValueOnce(new Error('Insufficient role'));
    expect((await GET()).status).toBe(403);
  });
});

describe('PUT /api/deal-rooms/settings', () => {
  it("upserts with the caller's client and answers like GET", async () => {
    const res = await put({
      inviteTemplateName: 'group_invite',
      inviteTemplateLanguage: 'en_US',
      inviteTemplateNameAr: '',
    });
    expect(res.status).toBe(200);
    expect(m.from).toHaveBeenCalledWith('deal_room_settings');
    expect(m.upsert).toHaveBeenCalledWith(
      {
        account_id: 'acct-1',
        invite_template_name: 'group_invite',
        invite_template_language: 'en_US',
        invite_template_name_ar: null,
        updated_by: 'user-1',
      },
      { onConflict: 'account_id' }
    );
    expect(await res.json()).toHaveProperty('metaNumber', true);
  });

  it('answers 400 to a name Meta would not have, and writes nothing', async () => {
    const res = await put({ inviteTemplateName: 'Group Invite!' });
    expect(res.status).toBe(400);
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it('answers 500 without the database wording when the write fails', async () => {
    m.upsert.mockResolvedValue({ error: { message: 'permission denied' } });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await put({ inviteTemplateName: 'group_invite' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'Could not save the deal room settings',
    });
    log.mockRestore();
  });
});
