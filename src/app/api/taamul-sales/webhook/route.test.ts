import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFakeDb,
  type FakeDb,
  type Row,
} from '@/lib/pbx/__tests__/fake-db';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/taamul-sales/admin', () => ({ taamulSalesDb: () => h.db }));

import { POST } from './route';

const SECRET = 'whsec_route_test';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
let fake: FakeDb;

const event = (over: Record<string, unknown> = {}) => ({
  event_id: 'evt-1',
  event_type: 'contact.interested',
  occurred_at: '2026-10-26T09:06:46.689876+00:00',
  contact: {
    id: 'tc-1',
    customer_name: 'Ahmed Ali',
    company_name: 'Infinity Development',
    phone_number: '0501234567',
    additional_phones: ['0559876543'],
    trade_license_number: 'CN-1234567',
    industry: 'REAL ESTATE',
    area: 'DXB',
    city: 'dubai',
    is_existing_customer: false,
  },
  agent: {
    id: 'ag-1',
    username: 'meet',
    full_name: 'Meet Karia',
    email: 'meet@taamulcredit.ae',
    team: { id: 'tm-1', name: 'Office Team A' },
  },
  call: {
    feedback_id: 'fb-1',
    called_at: '2026-10-26T09:05:00Z',
    notes: 'Call back Sunday',
  },
  lead: { id: 'lead-1', status: 'new', created_at: '2026-10-26T09:06:46Z' },
  ...over,
});

const sign = (body: string, ts: string, secret = SECRET) =>
  'sha256=' +
  crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

function post(
  payload: unknown,
  o: { ts?: number; sig?: string; secret?: string } = {}
) {
  const body = JSON.stringify(payload);
  const ts = String(o.ts ?? Math.floor(Date.now() / 1000));
  return POST(
    new Request('https://crm.example.com/api/taamul-sales/webhook', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-taamul-event': String((payload as Row).event_type),
        'x-taamul-event-id': String((payload as Row).event_id),
        'x-taamul-delivery-id': 'dlv-1',
        'x-taamul-delivery-attempt': '1',
        'x-taamul-timestamp': ts,
        'x-taamul-signature': o.sig ?? sign(body, ts, o.secret),
      },
    })
  );
}

/** taamul_sales_record_interested as 139 writes it, for these tests. */
function recordRpc(args: Row) {
  const events = fake.tables.taamul_sales_events;
  if (events.some((e) => e.event_id === args.p_event_id)) {
    return { data: 'duplicate', error: null };
  }
  events.push({
    event_id: args.p_event_id,
    account_id: args.p_account_id,
    payload: args.p_payload,
  });
  const contacts = fake.tables.taamul_sales_contacts;
  let row = contacts.find(
    (c) =>
      c.account_id === args.p_account_id &&
      c.taamul_contact_id === args.p_taamul_contact_id
  );
  if (!row) {
    row = {
      account_id: args.p_account_id,
      taamul_contact_id: args.p_taamul_contact_id,
      interested_count: 0,
    };
    contacts.push(row);
  }
  row.interested_count = Number(row.interested_count) + 1;
  Object.assign(row, args.p_fields as Row);
  return { data: 'recorded', error: null };
}

const rpcCalls = () =>
  fake.log.filter((l) => l.table === 'rpc:taamul_sales_record_interested');

beforeEach(() => {
  vi.stubEnv('TAAMUL_WEBHOOK_SECRET', SECRET);
  vi.stubEnv('TAAMUL_WEBHOOK_ACCOUNT_ID', ACCOUNT);
  fake = createFakeDb(
    { taamul_sales_events: [], taamul_sales_contacts: [], contacts: [] },
    { taamul_sales_record_interested: recordRpc }
  );
  h.db = fake.db;
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/taamul-sales/webhook', () => {
  it('stores a validly signed event as an OpenDesk contact', async () => {
    const res = await post(event());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'recorded' });

    expect(rpcCalls()).toHaveLength(1);
    expect(rpcCalls()[0].payload).toEqual({
      p_account_id: ACCOUNT,
      p_event_id: 'evt-1',
      p_event_type: 'contact.interested',
      p_occurred_at: '2026-10-26T09:06:46.689Z',
      p_taamul_contact_id: 'tc-1',
      p_delivery_id: 'dlv-1',
      p_payload: event(),
      p_fields: {
        customer_name: 'Ahmed Ali',
        company_name: 'Infinity Development',
        phone: '971501234567',
        phone_raw: '0501234567',
        additional_phones: ['971559876543'],
        trade_license_number: 'CN-1234567',
        industry: 'REAL ESTATE',
        area: 'DXB',
        city: 'dubai',
        is_existing_customer: false,
        agent_id: 'ag-1',
        agent_username: 'meet',
        agent_name: 'Meet Karia',
        agent_email: 'meet@taamulcredit.ae',
        agent_team: 'Office Team A',
        call_feedback_id: 'fb-1',
        called_at: '2026-10-26T09:05:00.000Z',
        call_notes: 'Call back Sunday',
        lead_id: 'lead-1',
        lead_status: 'new',
        lead_created_at: '2026-10-26T09:06:46.000Z',
      },
    });
    expect(fake.tables.taamul_sales_contacts).toHaveLength(1);
    // Kept apart from the CRM's contacts, like Compass customers.
    expect(fake.tables.contacts).toEqual([]);
    expect(fake.log.some((l) => l.table === 'contacts')).toBe(false);
  });

  it('refuses a bad signature with 401 and touches nothing', async () => {
    const res = await post(event(), { secret: 'not-the-secret' });
    expect(res.status).toBe(401);
    expect(fake.log).toEqual([]);
  });

  it('refuses a stale timestamp with 401, however well signed', async () => {
    const res = await post(event(), {
      ts: Math.floor(Date.now() / 1000) - 301,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Timestamp out of range' });
    expect(fake.log).toEqual([]);
  });

  it('records the same event_id once and answers 200 both times', async () => {
    expect((await post(event())).status).toBe(200);
    const again = await post(event());
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, status: 'duplicate' });

    expect(fake.tables.taamul_sales_events).toHaveLength(1);
    expect(fake.tables.taamul_sales_contacts).toHaveLength(1);
    expect(fake.tables.taamul_sales_contacts[0].interested_count).toBe(1);
  });

  it('answers a ping with 200 and writes nothing', async () => {
    const res = await post({
      event_id: 'ping-1',
      event_type: 'ping',
      occurred_at: '2026-10-26T09:00:00Z',
      message: 'Connectivity test',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'pong' });
    expect(fake.log).toEqual([]);
  });

  it('a second mark of the same contact updates the same row', async () => {
    await post(event());
    const res = await post(
      event({
        event_id: 'evt-2',
        occurred_at: '2026-10-27T10:00:00Z',
        contact: { ...event().contact, phone_number: '0507654321' },
      })
    );
    expect(await res.json()).toEqual({ ok: true, status: 'recorded' });
    // Keyed on the sales app's contact id: a new phone is not a new row.
    expect(fake.tables.taamul_sales_contacts).toHaveLength(1);
    expect(fake.tables.taamul_sales_contacts[0]).toMatchObject({
      interested_count: 2,
      phone: '971507654321',
    });
  });

  it('still stores an event whose phone is unusable', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = event();
    const res = await post({
      ...body,
      contact: { ...body.contact, phone_number: '12345' },
    });
    expect(await res.json()).toEqual({ ok: true, status: 'recorded' });
    expect(fake.tables.taamul_sales_contacts[0]).toMatchObject({
      phone: null,
      phone_raw: '12345',
    });
    expect(spy.mock.calls.flat().join(' ')).not.toContain('12345');
    spy.mockRestore();
  });

  it('answers 503 when storing fails, so the sales app redelivers', async () => {
    fake.rpcs.taamul_sales_record_interested = () => ({
      data: null,
      error: { message: 'Key (phone)=(971501234567) exists', code: '23505' },
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(event());
    expect(res.status).toBe(503);
    // The log names the event and the code, never the customer's data.
    expect(spy.mock.calls.flat().join(' ')).not.toContain('971501234567');
    expect(spy.mock.calls.flat().join(' ')).toContain('evt-1');
    spy.mockRestore();
  });

  it('fails closed with 503 when the secret or workspace is not set', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('TAAMUL_WEBHOOK_SECRET', '');
    expect((await post(event())).status).toBe(503);
    vi.stubEnv('TAAMUL_WEBHOOK_SECRET', SECRET);
    vi.stubEnv('TAAMUL_WEBHOOK_ACCOUNT_ID', '');
    expect((await post(event())).status).toBe(503);
    expect(fake.log).toEqual([]);
    spy.mockRestore();
  });

  it('acknowledges an unknown event type, and refuses a malformed one', async () => {
    const unknown = await post({ event_id: 'x', event_type: 'contact.lost' });
    expect(await unknown.json()).toEqual({ ok: true, status: 'ignored' });
    const bad = await post(event({ contact: {} }));
    expect(bad.status).toBe(400);
    expect(fake.log).toEqual([]);
  });
});
