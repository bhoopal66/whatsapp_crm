import { describe, expect, it } from 'vitest';
import type { AudienceConfig } from '@/hooks/use-broadcast-sending';
import {
  DRAFT_CSV_MAX_ROWS,
  deserializeDraft,
  draftResumeStep,
  reopenedScheduledAt,
  serializeDraft,
  type DraftInput,
} from './draft-state';

const base = (audience: AudienceConfig): DraftInput => ({
  template: { name: 'promo', language: 'en' },
  audience,
  variables: { '1': { source: 'contact_field', field: 'name' } as never },
  headerMediaUrl: 'https://x/y.png',
  name: 'Spring',
  scheduledAt: new Date('2030-01-01T10:00:00Z'),
  quietHours: { start: '21:00', end: '08:00', tz: 'Asia/Dubai' },
  followUpFlowId: 'flow-1',
});

describe('draft round trip', () => {
  it('keeps the whole wizard through JSON', () => {
    const audience: AudienceConfig = {
      type: 'chat_tags',
      chatTagIds: ['a', 'b'],
      chatTagMatch: 'all',
      excludeChatTagIds: ['x'],
      skipRecentDays: 7,
      bankCodes: ['ADCB'],
      bankSource: 'chat_tag',
      leadSources: ['ad', 'web_form'],
    };
    const stored = JSON.parse(JSON.stringify(serializeDraft(base(audience))));
    const back = deserializeDraft(stored)!;
    expect(back.template).toEqual({ name: 'promo', language: 'en' });
    expect(back.audience).toMatchObject(audience);
    expect(back.name).toBe('Spring');
    expect(back.scheduledAt).toBe('2030-01-01T10:00:00.000Z');
    expect(back.quietHours?.tz).toBe('Asia/Dubai');
    expect(back.followUpFlowId).toBe('flow-1');
    expect(back.headerMediaUrl).toBe('https://x/y.png');
    expect(back.csvDropped).toBe(false);
  });

  it('keeps custom-field and compass selections, drops the compass sample', () => {
    const audience: AudienceConfig = {
      type: 'compass',
      compass: { offset: 10, limit: 50, order: 'newest' } as never,
      compassSample: { phone: '1' } as never,
      compassSampleRows: [{ phone: '1' } as never],
      compassSampleKey: 'k',
    };
    const back = deserializeDraft(
      JSON.parse(JSON.stringify(serializeDraft(base(audience))))
    )!;
    expect(back.audience.compass).toEqual(audience.compass);
    expect(back.audience.compassSample).toBeUndefined();
    expect(back.audience.compassSampleRows).toBeUndefined();
  });

  it('stores a small CSV and flags a big one as dropped', () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ phone: `97150${i}` }));
    const small = serializeDraft(
      base({ type: 'csv', csvContacts: rows(10) as never })
    );
    expect(small.audience.csvContacts).toHaveLength(10);
    expect(small.csvDropped).toBe(false);
    const big = serializeDraft(
      base({ type: 'csv', csvContacts: rows(DRAFT_CSV_MAX_ROWS + 1) as never })
    );
    expect(big.audience.csvContacts).toBeUndefined();
    expect(big.csvDropped).toBe(true);
  });
});

describe('deserializeDraft', () => {
  it('rejects non-drafts and tolerates old/partial shapes', () => {
    expect(deserializeDraft(null)).toBeNull();
    expect(deserializeDraft({ v: 2 })).toBeNull();
    const d = deserializeDraft({ v: 1, audience: { type: 'bogus' } })!;
    expect(d.audience.type).toBe('all');
    expect(d.audience.chatTagMatch).toBe('any');
    expect(d.template).toBeNull();
    expect(d.variables).toEqual({});
  });
});

describe('draftResumeStep', () => {
  it('lands on the furthest step whose input exists', () => {
    const a: AudienceConfig = { type: 'all' };
    expect(draftResumeStep({ audience: a, name: '' }, false)).toBe(0);
    expect(
      draftResumeStep({ audience: { type: 'chat_tags' }, name: 'x' }, true)
    ).toBe(1);
    expect(draftResumeStep({ audience: a, name: ' ' }, true)).toBe(2);
    expect(draftResumeStep({ audience: a, name: 'x' }, true)).toBe(3);
  });
});

describe('reopenedScheduledAt', () => {
  it('drops a time that has passed', () => {
    const now = new Date('2030-06-01T00:00:00Z');
    expect(reopenedScheduledAt('2030-01-01T00:00:00Z', now)).toBeNull();
    expect(reopenedScheduledAt('2031-01-01T00:00:00Z', now)).toEqual(
      new Date('2031-01-01T00:00:00Z')
    );
    expect(reopenedScheduledAt(null, now)).toBeNull();
  });
});
