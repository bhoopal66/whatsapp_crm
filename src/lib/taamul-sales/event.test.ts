import { describe, expect, it } from 'vitest';

import { normalizeSalesPhone, parseTaamulEvent } from './event';

const interested = () => ({
  event_id: 'b8f1c7de-0000-4000-8000-000000000001',
  event_type: 'contact.interested',
  occurred_at: '2026-10-26T09:06:46.689876+00:00',
  contact: {
    id: 'c0ffee00-0000-4000-8000-000000000001',
    customer_name: 'Ahmed Ali',
    company_name: 'Infinity Development',
    phone_number: '0501234567',
    additional_phones: ['0559876543', '0501234567', '0559876543', 'n/a'],
    trade_license_number: 'CN-1234567',
    industry: 'REAL ESTATE',
    area: 'DXB',
    city: 'dubai',
    is_existing_customer: false,
    a_field_added_later: { x: 1 },
  },
  agent: {
    id: 'a9e00000-0000-4000-8000-000000000001',
    username: 'meet',
    full_name: 'Meet Karia',
    email: 'Meet@TaamulCredit.ae',
    team: { id: 't1', name: 'Office Team A' },
  },
  call: {
    feedback_id: 'f1',
    called_at: '2026-10-26T09:05:00Z',
    notes: 'Wants a call back on Sunday',
  },
  lead: { id: 'l1', status: 'new', created_at: '2026-10-26T09:06:46Z' },
});

describe('normalizeSalesPhone', () => {
  it('turns a UAE local number into the CRM form', () => {
    expect(normalizeSalesPhone('0501234567')).toEqual({
      phone: '971501234567',
      error: null,
    });
    expect(normalizeSalesPhone('+971 50 123 4567').phone).toBe('971501234567');
  });

  it('reports a number it cannot use instead of guessing', () => {
    expect(normalizeSalesPhone('050123')).toEqual({
      phone: null,
      error: expect.any(String),
    });
    expect(normalizeSalesPhone(null)).toEqual({ phone: null, error: null });
  });
});

describe('parseTaamulEvent', () => {
  it('maps a contact.interested event and ignores unknown fields', () => {
    const parsed = parseTaamulEvent(interested());
    expect(parsed.kind).toBe('interested');
    if (parsed.kind !== 'interested') return;
    expect(parsed.event).toEqual({
      eventId: 'b8f1c7de-0000-4000-8000-000000000001',
      eventType: 'contact.interested',
      occurredAt: '2026-10-26T09:06:46.689Z',
      contact: {
        id: 'c0ffee00-0000-4000-8000-000000000001',
        customerName: 'Ahmed Ali',
        companyName: 'Infinity Development',
        phone: '971501234567',
        phoneRaw: '0501234567',
        phoneError: null,
        additionalPhones: ['971559876543'],
        tradeLicenseNumber: 'CN-1234567',
        industry: 'REAL ESTATE',
        area: 'DXB',
        city: 'dubai',
        isExistingCustomer: false,
      },
      agent: {
        id: 'a9e00000-0000-4000-8000-000000000001',
        username: 'meet',
        fullName: 'Meet Karia',
        email: 'meet@taamulcredit.ae',
        team: 'Office Team A',
      },
      call: {
        feedbackId: 'f1',
        calledAt: '2026-10-26T09:05:00.000Z',
        notes: 'Wants a call back on Sunday',
      },
      lead: {
        id: 'l1',
        status: 'new',
        createdAt: '2026-10-26T09:06:46.000Z',
      },
    });
  });

  it('accepts the nullable parts as null', () => {
    const body = interested();
    const parsed = parseTaamulEvent({
      ...body,
      contact: {
        ...body.contact,
        customer_name: null,
        trade_license_number: null,
      },
      agent: { ...body.agent, full_name: null, team: null },
      call: { ...body.call, notes: null },
      lead: null,
    });
    expect(parsed.kind).toBe('interested');
    if (parsed.kind !== 'interested') return;
    expect(parsed.event.contact.customerName).toBeNull();
    expect(parsed.event.agent.team).toBeNull();
    expect(parsed.event.lead).toEqual({
      id: null,
      status: null,
      createdAt: null,
    });
  });

  it('answers a ping, and acknowledges an event type it does not know', () => {
    expect(
      parseTaamulEvent({
        event_id: 'p1',
        event_type: 'ping',
        occurred_at: '2026-10-26T09:00:00Z',
        message: 'hello',
      })
    ).toEqual({ kind: 'ping', eventId: 'p1' });
    expect(
      parseTaamulEvent({ event_id: 'x', event_type: 'contact.lost' })
    ).toEqual({ kind: 'ignored', eventId: 'x', eventType: 'contact.lost' });
  });

  it('refuses an interested event without its ids or time', () => {
    const body = interested();
    expect(parseTaamulEvent({ ...body, event_id: '' }).kind).toBe('invalid');
    expect(parseTaamulEvent({ ...body, occurred_at: 'yesterday' }).kind).toBe(
      'invalid'
    );
    expect(
      parseTaamulEvent({ ...body, contact: { ...body.contact, id: null } }).kind
    ).toBe('invalid');
    expect(parseTaamulEvent([body]).kind).toBe('invalid');
  });
});
