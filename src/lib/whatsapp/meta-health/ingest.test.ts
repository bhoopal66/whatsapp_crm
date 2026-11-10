import { describe, expect, it } from 'vitest';

import {
  healthEventRecordArgs,
  ingestMetaHealth,
  metaHealthDedupKey,
  numberStateSetArgs,
  templateHealthSetArgs,
  type HealthEvent,
} from './ingest';

const WABA = '102290129340398';
const TIME = 1759600000; // 2025-10-04T17:46:40Z
const AT = '2025-10-04T17:46:40.000Z';
const RECEIPT = new Date('2026-10-05T08:00:00.000Z');
const now = () => RECEIPT;

const change = (field: string, value: unknown) => ({ field, value });
const body = (...changes: unknown[]) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: WABA, time: TIME, changes }],
});
const run = (payload: unknown) => ingestMetaHealth(payload, now);
const one = (payload: unknown) => {
  const r = run(payload);
  expect(r.errors).toEqual([]);
  expect(r.events).toHaveLength(1);
  return r.events[0]!.event;
};

describe('ingestMetaHealth: each handled field', () => {
  it('phone_number_quality_update', () => {
    expect(
      one(
        body(
          change('phone_number_quality_update', {
            display_phone_number: '971501234567',
            event: 'DOWNGRADE',
            current_limit: 'TIER_1K',
          })
        )
      )
    ).toEqual({
      kind: 'phone_number_quality_update',
      wabaId: WABA,
      at: AT,
      event: 'DOWNGRADE',
      currentLimit: 'TIER_1K',
      displayPhoneNumber: '971501234567',
    });
  });

  it('message_template_status_update (numeric template id stringified)', () => {
    expect(
      one(
        body(
          change('message_template_status_update', {
            event: 'REJECTED',
            message_template_id: 594425479261596,
            message_template_name: 'file_update_v2',
            message_template_language: 'en_US',
            reason: 'INCORRECT_CATEGORY',
          })
        )
      )
    ).toEqual({
      kind: 'message_template_status_update',
      wabaId: WABA,
      at: AT,
      event: 'REJECTED',
      templateId: '594425479261596',
      templateName: 'file_update_v2',
      templateLanguage: 'en_US',
      reason: 'INCORRECT_CATEGORY',
    });
  });

  it('message_template_quality_update', () => {
    expect(
      one(
        body(
          change('message_template_quality_update', {
            previous_quality_score: 'GREEN',
            new_quality_score: 'YELLOW',
            message_template_id: '77',
            message_template_name: 'file_update_v2',
          })
        )
      )
    ).toEqual({
      kind: 'message_template_quality_update',
      wabaId: WABA,
      at: AT,
      newQuality: 'YELLOW',
      previousQuality: 'GREEN',
      templateId: '77',
      templateName: 'file_update_v2',
    });
  });

  it('account_update with restriction, violation and ban info', () => {
    expect(
      one(
        body(
          change('account_update', {
            event: 'ACCOUNT_RESTRICTION',
            phone_number: '971501234567',
            restriction_info: [
              {
                restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING',
                expiration: TIME + 86400,
              },
              { restriction_type: 'RESTRICTED_ADD_PHONE_NUMBER_ACTION' },
            ],
            violation_info: { violation_type: 'SPAM' },
            ban_info: { waba_ban_state: 'SCHEDULE_FOR_DISABLE' },
          })
        )
      )
    ).toEqual({
      kind: 'account_update',
      wabaId: WABA,
      at: AT,
      event: 'ACCOUNT_RESTRICTION',
      displayPhoneNumber: '971501234567',
      restrictions: [
        {
          type: 'RESTRICTED_BIZ_INITIATED_MESSAGING',
          expiresAt: '2025-10-05T17:46:40.000Z',
        },
        { type: 'RESTRICTED_ADD_PHONE_NUMBER_ACTION' },
      ],
      violationType: 'SPAM',
      banState: 'SCHEDULE_FOR_DISABLE',
    });
  });

  it('account_review_update: event = decision', () => {
    expect(
      one(body(change('account_review_update', { decision: 'REJECTED' })))
    ).toEqual({
      kind: 'account_review_update',
      wabaId: WABA,
      at: AT,
      event: 'REJECTED',
    });
  });
});

describe('ingestMetaHealth: skipped fields, entries and time', () => {
  it('messages, group_* and unknown fields are skipped silently', () => {
    const r = run(
      body(
        change('messages', { messages: [{ id: 'wamid.1' }] }),
        change('group_lifecycle_update', { group_id: 'g' }),
        change('template_category_update', { new_category: 'MARKETING' }),
        change('phone_number_quality_update', { event: 'UPGRADE' })
      )
    );
    expect(r.errors).toEqual([]);
    expect(r.events.map((e) => e.event.kind)).toEqual([
      'phone_number_quality_update',
    ]);
  });

  it('a messages-only entry with a bad time reports nothing', () => {
    const r = run({
      entry: [{ time: 'yesterday', changes: [change('messages', {})] }],
    });
    expect(r).toEqual({ events: [], errors: [] });
  });

  it('multiple entries keep order and their own WABA id', () => {
    const r = run({
      entry: [
        {
          id: 'A',
          time: TIME,
          changes: [
            change('phone_number_quality_update', { event: 'FLAGGED' }),
            change('account_review_update', { decision: 'APPROVED' }),
          ],
        },
        {
          id: 'B',
          time: TIME + 60,
          changes: [
            change('message_template_quality_update', {
              new_quality_score: 'RED',
              message_template_name: 't1',
            }),
          ],
        },
      ],
    });
    expect(r.errors).toEqual([]);
    expect(
      r.events.map((e) => [e.event.wabaId, e.event.kind, e.event.at])
    ).toEqual([
      ['A', 'phone_number_quality_update', AT],
      ['A', 'account_review_update', AT],
      ['B', 'message_template_quality_update', '2025-10-04T17:47:40.000Z'],
    ]);
  });

  it('missing time → receipt time silently; invalid → receipt time + error', () => {
    const ev = change('phone_number_quality_update', { event: 'FLAGGED' });
    const missing = run({ entry: [{ changes: [ev] }] });
    expect(missing.errors).toEqual([]);
    expect(missing.events[0]!.event.at).toBe(RECEIPT.toISOString());
    expect(missing.events[0]!.event.wabaId).toBeUndefined();
    const bad = run({ entry: [{ time: 'yesterday', changes: [ev] }] });
    expect(bad.errors).toEqual([
      'MALFORMED: invalid entry time, using receipt time',
    ]);
    expect(bad.events[0]!.event.at).toBe(RECEIPT.toISOString());
  });
});

describe('metaHealthDedupKey', () => {
  it('is sha256 hex, independent of key order, distinct per change', () => {
    const a = metaHealthDedupKey({
      field: 'account_update',
      value: { event: 'X', ban_info: { a: 1, b: 2 } },
      entryId: WABA,
      entryTime: TIME,
    });
    const b = metaHealthDedupKey({
      entryTime: TIME,
      entryId: WABA,
      value: { ban_info: { b: 2, a: 1 }, event: 'X' },
      field: 'account_update',
    });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    for (const other of [
      { field: 'account_review_update' },
      { value: { event: 'Y' } },
      { entryId: 'other' },
      { entryTime: TIME + 1 },
    ]) {
      expect(
        metaHealthDedupKey({
          field: 'account_update',
          value: { event: 'X', ban_info: { a: 1, b: 2 } },
          entryId: WABA,
          entryTime: TIME,
          ...other,
        })
      ).not.toBe(a);
    }
  });

  it('a redelivery yields the same key, also without an entry time', () => {
    const payload = {
      entry: [
        { id: WABA, changes: [change('account_update', { event: 'E' })] },
      ],
    };
    const first = ingestMetaHealth(payload, () => new Date(1));
    const again = ingestMetaHealth(payload, () => new Date(2));
    expect(again.events[0]!.dedupKey).toBe(first.events[0]!.dedupKey);
  });
});

describe('ingestMetaHealth: malformed input never throws', () => {
  it('shape-level malformations become errors, not events', () => {
    const r = run(
      body(
        { value: { event: 'FLAGGED' } },
        change('phone_number_quality_update', 'not an object'),
        change('phone_number_quality_update', { display_phone_number: '971' }),
        change('message_template_status_update', { event: 'APPROVED' }),
        change('message_template_status_update', {
          message_template_name: 't',
        }),
        change('message_template_quality_update', {
          message_template_name: 't',
        }),
        change('account_update', { phone_number: '971' }),
        change('account_update', {
          event: 'ACCOUNT_RESTRICTION',
          restriction_info: [{ expiration: 1 }, 'x'],
        })
      )
    );
    expect(r.errors).toEqual([
      'MALFORMED: change without field skipped',
      'MALFORMED: phone_number_quality_update without value object skipped',
      'MALFORMED: phone_number_quality_update without event or current_limit skipped',
      'MALFORMED: message_template_status_update without event or template id/name skipped',
      'MALFORMED: message_template_status_update without event or template id/name skipped',
      'MALFORMED: message_template_quality_update without new_quality_score or template id/name skipped',
      'MALFORMED: account_update without event/decision skipped',
      'MALFORMED: account_update restriction without restriction_type ignored',
      'MALFORMED: account_update restriction without restriction_type ignored',
    ]);
    expect(r.events.map((e) => e.event)).toEqual([
      {
        kind: 'account_update',
        wabaId: WABA,
        at: AT,
        event: 'ACCOUNT_RESTRICTION',
      },
    ]);
  });

  it('a throwing entry or change costs one error, never the batch', () => {
    const hostileEntry = Object.defineProperty({}, 'changes', {
      enumerable: true,
      get() {
        throw new Error('boom-entry');
      },
    });
    const hostileChange = Object.defineProperty({}, 'field', {
      enumerable: true,
      get() {
        throw new Error('boom-change');
      },
    });
    const r = run({
      entry: [
        hostileEntry,
        {
          id: WABA,
          time: TIME,
          changes: [
            hostileChange,
            change('phone_number_quality_update', { event: 'FLAGGED' }),
          ],
        },
      ],
    });
    expect(r.errors).toEqual([
      'MALFORMED: item skipped: Error: boom-entry',
      'MALFORMED: item skipped: Error: boom-change',
    ]);
    expect(r.events).toHaveLength(1);
  });

  it('a throwing top-level getter returns an error', () => {
    const hostile = Object.defineProperty({}, 'entry', {
      get() {
        throw new Error('boom-top');
      },
    });
    expect(run(hostile)).toEqual({
      events: [],
      errors: ['MALFORMED: ingest failed: Error: boom-top'],
    });
  });

  it('garbage inputs', () => {
    let deep: unknown = [];
    for (let i = 0; i < 10_000; i++) deep = [deep];
    const garbage: unknown[] = [
      null,
      undefined,
      '',
      '{"entry":[]}',
      42,
      NaN,
      true,
      [],
      deep,
      {},
      { entry: null },
      { entry: 'x' },
    ];
    for (const g of garbage) {
      expect(run(g)).toEqual({
        events: [],
        errors: ['MALFORMED: body is not a webhook payload (missing entry[])'],
      });
    }
    const inner = run({
      entry: [
        null,
        1,
        's',
        deep,
        { changes: deep },
        { changes: [null, 7, deep, { field: 5 }] },
      ],
    });
    expect(inner.events).toEqual([]);
    expect(inner.errors).toEqual(
      Array(5).fill('MALFORMED: change without field skipped')
    );
  });
});

describe('RPC arguments', () => {
  const ev = (patch: Partial<HealthEvent>): HealthEvent => ({
    kind: 'message_template_status_update',
    at: AT,
    templateName: 'promo',
    templateLanguage: 'en_US',
    event: 'PAUSED',
    ...patch,
  });

  it('meta_health_event_record: kind verbatim, payload an object', () => {
    const [ing] = run(
      body(change('account_review_update', { decision: 'APPROVED' }))
    ).events;
    expect(healthEventRecordArgs('acc', 'cfg', ing!)).toEqual({
      p_account: 'acc',
      p_config: 'cfg',
      p_kind: 'account_review_update',
      p_dedup_key: ing!.dedupKey,
      p_payload: ing!.event,
    });
  });

  it('meta_template_health_set: status or quality, else null', () => {
    expect(templateHealthSetArgs('acc', ev({}))).toEqual({
      p_account: 'acc',
      p_template_name: 'promo',
      p_language: 'en_US',
      p_quality: null,
      p_status: 'PAUSED',
      p_paused_until: null,
      p_at: AT,
    });
    expect(
      templateHealthSetArgs(
        'acc',
        ev({ kind: 'message_template_quality_update', newQuality: ' red ' })
      )
    ).toMatchObject({ p_quality: 'RED', p_status: null });
    for (const bad of [
      ev({ kind: 'message_template_quality_update', newQuality: 'PURPLE' }),
      ev({ event: 'X'.repeat(65) }),
      ev({ templateLanguage: undefined }),
      ev({ templateLanguage: 'x'.repeat(33) }),
      ev({ templateName: ' \t' }),
      ev({ kind: 'account_update' }),
    ]) {
      expect(templateHealthSetArgs('acc', bad)).toBeNull();
    }
  });

  it('meta_number_state_set: values normalised to the CHECKs', () => {
    expect(
      numberStateSetArgs('cfg', null, {
        qualityRating: 'YELLOW',
        messagingLimitTier: ' TIER_1K ',
        accountStatus: 'FLAGGED',
        assessedState: 'MARKETING_PAUSED',
        reasons: ['QUALITY_YELLOW', 'STATUS_FLAGGED'],
      })
    ).toEqual({
      p_config: 'cfg',
      p_expected_updated_at: null,
      p_quality_rating: 'YELLOW',
      p_messaging_limit_tier: 'TIER_1K',
      p_account_status: 'FLAGGED',
      p_assessed_state: 'MARKETING_PAUSED',
      p_reasons: ['QUALITY_YELLOW', 'STATUS_FLAGGED'],
    });
    expect(
      numberStateSetArgs('cfg', 't', {
        qualityRating: 'PURPLE' as never,
        messagingLimitTier: 'x'.repeat(65),
        accountStatus: '\u0085' as never,
        assessedState: 'ON_FIRE' as never,
        reasons: [],
      })
    ).toMatchObject({
      p_expected_updated_at: 't',
      p_quality_rating: null,
      p_messaging_limit_tier: null,
      p_account_status: null,
      p_assessed_state: 'NORMAL',
    });
  });
});
