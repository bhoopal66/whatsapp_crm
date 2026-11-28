import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SERVICE_DETAILS_SETTINGS,
  pickServiceLabel,
  qualifyCall,
  runServiceDetails,
  SERVICE_FALLBACK,
  toE164,
  type ContactHit,
  type FinishedCall,
  type ServiceDetailsPorts,
} from './service-details';

const call = (over: Partial<FinishedCall> = {}): FinishedCall => ({
  callRowId: 'call-1',
  accountId: 'acc-1',
  direction: 'inbound',
  answered: true,
  agentExtension: '1001',
  agentKnown: true,
  talkSeconds: 45,
  customerNumber: '0501234567',
  queue: null,
  did: null,
  ...over,
});

const on = {
  ...DEFAULT_SERVICE_DETAILS_SETTINGS,
  enabled: true,
  templateName: 'svc_details',
  language: 'en',
};
const contact = (over: Partial<ContactHit> = {}): ContactHit => ({
  id: 'ct-1',
  name: 'Sara',
  optedOutAt: null,
  doNotContactAt: null,
  ...over,
});

function ports(over: Partial<ServiceDetailsPorts> = {}) {
  const claimed = new Set<string>();
  const p: ServiceDetailsPorts = {
    loadSettings: vi.fn(async () => on),
    loadMap: vi.fn(async () => [
      { matchType: 'queue' as const, matchValue: '6400', label: 'Car loans' },
    ]),
    findContacts: vi.fn(async () => [contact()]),
    // Once per call id, as pbx_service_details_claim answers.
    claim: vi.fn(async (c: FinishedCall) => {
      if (claimed.has(c.callRowId)) return 'duplicate' as const;
      claimed.add(c.callRowId);
      return 'claimed' as const;
    }),
    send: vi.fn(async () => true),
    settle: vi.fn(async () => {}),
    ...over,
  };
  return p;
}

describe('toE164', () => {
  it.each([
    ['0501234567', '+971501234567'],
    ['00971 50 123 4567', '+971501234567'],
    ['+44 (20) 7946-0958', '+442079460958'],
    ['501234567', '+971501234567'],
    ['971501234567', '+971501234567'],
  ])('%s -> %s', (raw, want) => expect(toE164(raw)).toBe(want));
  it.each(['', null, '1234', 'abc', '+0123456789'])('%s is unusable', (raw) =>
    expect(toE164(raw)).toBeNull()
  );
});

describe('pickServiceLabel', () => {
  const map = [
    { matchType: 'extension' as const, matchValue: '1001', label: 'Ext desk' },
    { matchType: 'did' as const, matchValue: '80012', label: 'Mortgages' },
    { matchType: 'queue' as const, matchValue: '6400', label: 'Car loans' },
  ];
  it('prefers queue, then DID, then extension', () => {
    expect(
      pickServiceLabel(
        { queue: '6400', did: '80012', agentExtension: '1001' },
        map
      )
    ).toBe('Car loans');
    expect(
      pickServiceLabel(
        { queue: '9', did: '80012', agentExtension: '1001' },
        map
      )
    ).toBe('Mortgages');
    expect(pickServiceLabel({ agentExtension: '1001' }, map)).toBe('Ext desk');
  });
  it('falls back to the neutral label', () => {
    expect(pickServiceLabel({ agentExtension: '2' }, map)).toBe(
      SERVICE_FALLBACK
    );
  });
});

describe('qualifyCall', () => {
  it('follows SPEC 028 order', () => {
    expect(qualifyCall(call({ answered: false }), on)).toBe('not_answered');
    expect(qualifyCall(call({ agentExtension: null }), on)).toBe('no_agent');
    expect(qualifyCall(call({ agentKnown: false }), on)).toBe('no_agent');
    expect(qualifyCall(call({ talkSeconds: 19 }), on)).toBe('too_short');
    expect(qualifyCall(call({ talkSeconds: 20 }), on)).toEqual({
      phone: '+971501234567',
    });
    expect(qualifyCall(call({ direction: 'outbound' }), on)).toBe(
      'direction_off'
    );
    expect(
      qualifyCall(call({ direction: 'outbound' }), { ...on, outbound: true })
    ).toEqual({ phone: '+971501234567' });
    expect(qualifyCall(call({ direction: 'internal' }), on)).toBe(
      'direction_off'
    );
    expect(qualifyCall(call({ customerNumber: '12' }), on)).toBe('bad_number');
  });
});

describe('runServiceDetails', () => {
  it('sends the template with the name and the service label', async () => {
    const p = ports();
    expect(await runServiceDetails(p, call({ queue: '6400' }))).toBe('sent');
    expect(p.send).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: '+971501234567',
        templateName: 'svc_details',
        params: ['Sara', 'Car loans'],
      })
    );
    expect(p.settle).toHaveBeenCalledWith(expect.anything(), 'sent');
  });

  it('sends once per call: a second delivery of the end is a duplicate', async () => {
    const p = ports();
    expect(await runServiceDetails(p, call())).toBe('sent');
    expect(await runServiceDetails(p, call())).toBe('duplicate');
    expect(p.send).toHaveBeenCalledTimes(1);
  });

  it('never sends to an opted-out or do-not-contact customer', async () => {
    for (const hit of [
      contact({ optedOutAt: '2026-11-01' }),
      contact({ doNotContactAt: '2026-11-01' }),
    ]) {
      const p = ports({ findContacts: vi.fn(async () => [hit]) });
      expect(await runServiceDetails(p, call())).toBe('opted_out');
      expect(p.send).not.toHaveBeenCalled();
    }
  });

  it('switched off: reads the settings only, no lookup, no ledger row', async () => {
    const off = ports({
      loadSettings: vi.fn(async () => ({ ...on, enabled: false })),
    });
    expect(await runServiceDetails(off, call())).toBe('switched_off');
    expect(off.findContacts).not.toHaveBeenCalled();
    expect(off.claim).not.toHaveBeenCalled();
    expect(off.send).not.toHaveBeenCalled();
  });

  it('records but never sends without a template', async () => {
    const off = ports({
      loadSettings: vi.fn(async () => ({ ...on, enabled: false })),
    });
    expect(await runServiceDetails(off, call())).toBe('switched_off');
    const none = ports({
      loadSettings: vi.fn(async () => ({ ...on, templateName: null })),
    });
    expect(await runServiceDetails(none, call())).toBe('no_template');
    expect(off.send).not.toHaveBeenCalled();
    expect(none.send).not.toHaveBeenCalled();
  });

  it('records none and several contacts without sending', async () => {
    const none = ports({ findContacts: vi.fn(async () => []) });
    expect(await runServiceDetails(none, call())).toBe('no_contact');
    const two = ports({
      findContacts: vi.fn(async () => [contact(), contact({ id: 'ct-2' })]),
    });
    expect(await runServiceDetails(two, call())).toBe('ambiguous_contact');
    expect(two.send).not.toHaveBeenCalled();
  });

  it('holds at the shared daily cap', async () => {
    const p = ports({
      claim: vi.fn(
        async (_c, o) => (o === 'sending' ? 'daily_cap' : 'claimed') as never
      ),
    });
    expect(await runServiceDetails(p, call())).toBe('daily_cap');
    expect(p.send).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const p = ports({
      loadSettings: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runServiceDetails(p, call())).toBe('error');
  });
});
