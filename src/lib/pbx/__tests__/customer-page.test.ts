import { describe, expect, it } from 'vitest';

import {
  customerHref,
  initials,
  mergeTimeline,
  putComposerPrefill,
  sourcesToPage,
  takeComposerPrefill,
  timelineHorizon,
  withinHorizon,
  type TimelineCall,
  type TimelineMessage,
  type TimelineNote,
} from '../timeline';

const call = (id: string, startedAt: string): TimelineCall => ({
  id,
  direction: 'inbound',
  status: 'answered',
  startedAt,
  answeredAt: startedAt,
  ringSeconds: 5,
  talkSeconds: 60,
  userId: null,
  userName: null,
  disposition: null,
  notes: null,
  recordingState: 'none',
});
const message = (id: string, createdAt: string): TimelineMessage => ({
  id,
  senderType: 'customer',
  senderId: null,
  senderName: null,
  text: 'hi',
  contentType: 'text',
  createdAt,
});
const note = (id: string, createdAt: string): TimelineNote => ({
  id,
  text: 'n',
  authorName: null,
  createdAt,
});

describe('customer page paging', () => {
  const paging = {
    calls: { oldest: '2026-10-10T08:00:00Z', more: true },
    messages: { oldest: '2026-10-11T08:00:00Z', more: true },
    notes: { oldest: '2026-09-01T08:00:00Z', more: false },
    internal: { oldest: null, more: false },
  };

  it('holds the timeline at the newest cut-off of a source with more rows', () => {
    expect(timelineHorizon(paging, 'all')).toBe(
      Date.parse('2026-10-11T08:00:00Z')
    );
    expect(sourcesToPage(paging, 'all')).toEqual(['messages']);
  });

  it('counts only the sources the filter shows', () => {
    expect(timelineHorizon(paging, 'calls')).toBe(
      Date.parse('2026-10-10T08:00:00Z')
    );
    expect(sourcesToPage(paging, 'calls')).toEqual(['calls']);
    // Notes are read to the end and internal shares come in one read.
    expect(timelineHorizon(paging, 'notes')).toBeNull();
    expect(sourcesToPage(paging, 'notes')).toEqual([]);
  });

  it('reads every source holding the horizon at once', () => {
    const tied = {
      calls: { oldest: '2026-10-11T08:00:00Z', more: true },
      messages: { oldest: '2026-10-11T08:00:00Z', more: true },
    };
    expect(sourcesToPage(tied, 'all')).toEqual(['calls', 'messages']);
  });

  it('is open-ended once every source is read to its end', () => {
    const done = {
      calls: { oldest: '2026-10-10T08:00:00Z', more: false },
      messages: { oldest: null, more: false },
    };
    expect(timelineHorizon(done, 'all')).toBeNull();
    expect(sourcesToPage(done, 'all')).toEqual([]);
    expect(timelineHorizon({}, 'all')).toBeNull();
  });

  it('keeps out entries a later page could still precede', () => {
    const entries = mergeTimeline({
      calls: [
        call('c1', '2026-10-12T08:00:00Z'),
        call('c2', '2026-10-10T08:00:00Z'),
      ],
      messages: [message('m1', '2026-10-11T08:00:00Z')],
      notes: [note('n1', '2026-09-01T08:00:00Z')],
    });
    const horizon = timelineHorizon(paging, 'all');
    expect(withinHorizon(entries, horizon).map((e) => e.id)).toEqual([
      'c1',
      'm1',
    ]);
    expect(withinHorizon(entries, null)).toHaveLength(4);
  });
});

describe('customer page links and prefill', () => {
  it('opens the customer page when the contact is known, else the chat', () => {
    expect(customerHref({ contactId: 'k1', conversationId: 'cv1' })).toBe(
      '/contacts/k1'
    );
    expect(customerHref({ contactId: null, conversationId: 'cv1' })).toBe(
      '/inbox?c=cv1'
    );
    expect(customerHref({ contactId: null, conversationId: null })).toBe(
      '/contacts'
    );
  });

  it('takes the first letters of the first two words', () => {
    expect(initials('Khalid Al Mansoori')).toBe('KA');
    expect(initials('  noor  ')).toBe('N');
    expect(initials(null)).toBe('');
  });

  it('leaves a prefill the composer takes once', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    expect(
      putComposerPrefill(storage, 'cv1', 'Sorry we missed your call')
    ).toBe(true);
    expect(takeComposerPrefill(storage, 'cv2')).toBeNull();
    expect(takeComposerPrefill(storage, 'cv1')).toBe(
      'Sorry we missed your call'
    );
    expect(takeComposerPrefill(storage, 'cv1')).toBeNull();
  });

  it('reports a prefill it could not leave', () => {
    const refusing = {
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(putComposerPrefill(refusing, 'cv1', 'x')).toBe(false);
    expect(putComposerPrefill(null, 'cv1', 'x')).toBe(false);
  });
});
