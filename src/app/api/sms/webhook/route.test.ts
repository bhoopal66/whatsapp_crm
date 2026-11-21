import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  config: vi.fn(),
  rpc: vi.fn(),
  markOptedOut: vi.fn(),
}));

vi.mock('@/lib/hr/automsg/sms-config', () => ({ smsWebhookConfig: h.config }));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: h.rpc }),
}));
vi.mock('@/lib/ai/opt-out', () => ({ markOptedOut: h.markOptedOut }));

import { POST } from './route';

const SECRET = 'sms-test-secret-0123456789';
const ACCOUNT = '11111111-2222-3333-4444-555555555555';
const CONTACT = '99999999-8888-7777-6666-555555555555';
const URL = 'http://localhost/api/sms/webhook';
const CFG = {
  secret: SECRET,
  accountId: ACCOUNT,
  allowQueryToken: false,
  allowIps: [] as string[],
};

function post(body: string, headers: Record<string, string> = {}, url = URL) {
  return new Request(url, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const BODY = JSON.stringify({
  // the payload's own account-ish field must never be used
  accountId: '00000000-0000-0000-0000-000000000000',
  sms_result: [
    { number: '+971501234567', user_id: 12, status: 'SENT_OK', ref_id: 'R1' },
  ],
  sms_deliver_status: [
    { number: '+971501234567', ref_id: 'R1', status_code: 0 },
  ],
  sms: [{ number: '+971501234567', text: 'STOP' }],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.config.mockReturnValue(CFG);
  h.markOptedOut.mockResolvedValue(true);
  h.rpc.mockImplementation(async (fn: string) => {
    if (fn === 'hr_automsg_sms_ref_record')
      return { data: 'stored', error: null };
    if (fn === 'hr_automsg_sms_contact') return { data: CONTACT, error: null };
    if (fn === 'hr_agent_supersede') return { data: 1, error: null };
    return { data: 'recorded', error: null };
  });
});

describe('POST /api/sms/webhook', () => {
  it('is 501 until configured', async () => {
    h.config.mockReturnValue(null);
    const res = await POST(post(BODY, { 'x-sms-token': SECRET }));
    expect(res.status).toBe(501);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('refuses a wrong or missing token before touching the database', async () => {
    for (const headers of [{}, { 'x-sms-token': 'wrong' }] as Record<
      string,
      string
    >[]) {
      const res = await POST(post(BODY, headers));
      expect(res.status).toBe(401);
    }
    // ?token= is refused unless allowed.
    const res = await POST(post(BODY, {}, `${URL}?token=${SECRET}`));
    expect(res.status).toBe(401);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('accepts ?token= when allowed and the header is absent', async () => {
    h.config.mockReturnValue({ ...CFG, allowQueryToken: true });
    const res = await POST(post(BODY, {}, `${URL}?token=${SECRET}`));
    expect(res.status).toBe(200);
  });

  it('refuses a caller outside the IP list, and an unknown IP', async () => {
    h.config.mockReturnValue({ ...CFG, allowIps: ['10.0.0.5'] });
    vi.stubEnv('EDGE_CLIENT_IP_HEADER', 'x-real-ip');
    let res = await POST(
      post(BODY, { 'x-sms-token': SECRET, 'x-real-ip': '10.0.0.6' })
    );
    expect(res.status).toBe(401);
    res = await POST(post(BODY, { 'x-sms-token': SECRET }));
    expect(res.status).toBe(401);
    res = await POST(
      post(BODY, { 'x-sms-token': SECRET, 'x-real-ip': '10.0.0.5' })
    );
    expect(res.status).toBe(200);
  });

  it('refuses an oversized body', async () => {
    const res = await POST(
      post('x'.repeat(256 * 1024 + 1), { 'x-sms-token': SECRET })
    );
    expect(res.status).toBe(413);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('stores refs, records statuses and opts a STOP out, all in the configured workspace', async () => {
    const res = await POST(post(BODY, { 'x-sms-token': SECRET }));
    expect(res.status).toBe(200);
    const calls = h.rpc.mock.calls.map(([fn, args]) => [fn, args]);
    expect(calls.map(([fn]) => fn)).toEqual([
      'hr_automsg_sms_ref_record',
      'hr_automsg_sms_delivery_record',
      'hr_automsg_sms_dlr_record',
      'hr_automsg_sms_contact',
      'hr_agent_supersede',
    ]);
    for (const [, args] of calls)
      expect((args as { p_account_id: string }).p_account_id).toBe(ACCOUNT);
    expect(calls[1][1]).toMatchObject({
      p_user_id: '12',
      p_state: 'sent',
      p_number: '+971501234567',
    });
    expect(calls[2][1]).toMatchObject({ p_ref_id: 'R1', p_state: 'delivered' });
    expect(h.markOptedOut).toHaveBeenCalledWith(expect.anything(), {
      accountId: ACCOUNT,
      contactId: CONTACT,
    });
    expect(await res.json()).toEqual({
      ok: true,
      counts: { recorded: 2, optout_recorded: 1 },
    });
  });

  it('a STOP from someone never texted opts nobody out', async () => {
    h.rpc.mockImplementation(async (fn: string) =>
      fn === 'hr_automsg_sms_contact'
        ? { data: null, error: null }
        : { data: 'recorded', error: null }
    );
    const res = await POST(
      post(
        JSON.stringify({ sms: [{ number: '+971500000000', text: 'STOP' }] }),
        {
          'x-sms-token': SECRET,
        }
      )
    );
    expect(await res.json()).toEqual({
      ok: true,
      counts: { optout_not_found: 1 },
    });
    expect(h.markOptedOut).not.toHaveBeenCalled();
  });

  it('one failing item does not stop the others, and nothing private is logged', async () => {
    h.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'hr_automsg_sms_ref_record') throw new Error('+971501234567');
      if (fn === 'hr_automsg_sms_delivery_record')
        return { data: null, error: { code: 'P0001' } };
      if (fn === 'hr_automsg_sms_contact')
        return { data: CONTACT, error: null };
      return { data: 'recorded', error: null };
    });
    const res = await POST(post(BODY, { 'x-sms-token': SECRET }));
    expect(await res.json()).toEqual({
      ok: true,
      counts: {
        ref_error: 1,
        status_error: 1,
        recorded: 1,
        optout_recorded: 1,
      },
    });
    const logged = JSON.stringify(
      (console.error as unknown as { mock: { calls: unknown[] } }).mock.calls
    );
    expect(logged).not.toContain('971501234567');
    expect(logged).not.toContain(SECRET);
  });
});
