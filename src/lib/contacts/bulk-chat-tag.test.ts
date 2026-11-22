import { describe, expect, it } from 'vitest';
import {
  BULK_CHAT_TAG_MAX_CONTACTS,
  parseBulkChatTagBody,
  tallyBulkOutcomes,
} from './bulk-chat-tag';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const T = '33333333-3333-4333-8333-333333333333';

describe('parseBulkChatTagBody', () => {
  it('accepts ids, dedupes them and keeps an absent sub-tag undefined', () => {
    const r = parseBulkChatTagBody({ contactIds: [A, B, A], chatTagId: T });
    expect(r).toEqual({
      ok: true,
      value: { contactIds: [A, B], chatTagId: T, subTagId: undefined },
    });
  });
  it('accepts null to clear', () => {
    const r = parseBulkChatTagBody({ contactIds: [A], chatTagId: null });
    expect(r.ok).toBe(true);
  });
  it('refuses bad input', () => {
    expect(parseBulkChatTagBody(null).ok).toBe(false);
    expect(parseBulkChatTagBody({ contactIds: [], chatTagId: T }).ok).toBe(
      false
    );
    expect(parseBulkChatTagBody({ contactIds: ['x'], chatTagId: T }).ok).toBe(
      false
    );
    expect(parseBulkChatTagBody({ contactIds: [A] }).ok).toBe(false);
    expect(
      parseBulkChatTagBody({ contactIds: [A], chatTagId: null, subTagId: T }).ok
    ).toBe(false);
    const many = Array.from(
      { length: BULK_CHAT_TAG_MAX_CONTACTS + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    );
    expect(parseBulkChatTagBody({ contactIds: many, chatTagId: T }).ok).toBe(
      false
    );
  });
});

describe('tallyBulkOutcomes', () => {
  it('counts each outcome', () => {
    expect(
      tallyBulkOutcomes([
        'updated',
        'updated',
        'skipped',
        'failed',
        'unchanged',
      ])
    ).toEqual({ updated: 2, unchanged: 1, skipped: 1, failed: 1 });
  });
});
