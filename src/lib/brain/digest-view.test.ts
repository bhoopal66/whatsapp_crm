import { describe, expect, it } from 'vitest';

import {
  DIGEST_ORDER,
  digestItemHref,
  digestUrl,
  parseDigest,
  viewAsOptions,
} from './digest-view';

const CASE = '11111111-2222-3333-4444-555555555555';

describe('parseDigest', () => {
  it('puts the four sections in a fixed order, empty when left out', () => {
    expect(DIGEST_ORDER).toEqual([
      'stale_cases',
      'promises',
      'related',
      'followups',
    ]);
    const view = parseDigest({
      generatedAt: '2026-11-12T05:00:00.000Z',
      aiGenerated: true,
      sections: [
        {
          kind: 'followups',
          title: 'Follow-ups',
          items: [{ caseId: CASE, label: 'TC-1', reason: 'Due today' }],
        },
        { kind: 'promises', title: 'Promises', items: [] },
      ],
    });
    expect(view?.sections.map((s) => s.kind)).toEqual([...DIGEST_ORDER]);
    expect(view?.sections[0].items).toEqual([]);
    expect(view?.sections[2].items).toEqual([]);
    expect(view?.sections[3].items).toEqual([
      { caseId: CASE, label: 'TC-1', reason: 'Due today' },
    ]);
    expect(view?.aiGenerated).toBe(true);
  });

  it('keeps a valid citation, drops bad items, unknown and repeated kinds', () => {
    const view = parseDigest({
      generatedAt: 'x',
      aiGenerated: true,
      sections: [
        {
          kind: 'stale_cases',
          items: [
            {
              caseId: CASE,
              label: 'A',
              reason: 'r',
              citation: { kind: 'message', id: 'm1' },
            },
            { caseId: CASE, label: 'B', reason: 'r', citation: { kind: 'x' } },
            { caseId: '', label: 'C', reason: 'r' },
            { caseId: CASE, label: 4, reason: 'r' },
            null,
          ],
        },
        {
          kind: 'stale_cases',
          items: [{ caseId: CASE, label: 'D', reason: 'r' }],
        },
        { kind: 'gossip', items: [{ caseId: CASE, label: 'E', reason: 'r' }] },
      ],
    });
    expect(view?.sections[0].items).toEqual([
      {
        caseId: CASE,
        label: 'A',
        reason: 'r',
        citation: { kind: 'message', id: 'm1' },
      },
      { caseId: CASE, label: 'B', reason: 'r' },
    ]);
    expect(view?.sections).toHaveLength(4);
  });

  it('returns null on a bad shape', () => {
    expect(parseDigest(null)).toBeNull();
    expect(parseDigest({ error: 'brain_disabled' })).toBeNull();
    expect(parseDigest({ generatedAt: 'x', sections: {} })).toBeNull();
  });
});

describe('digest links and URL', () => {
  it('links an item to its case page', () => {
    expect(digestItemHref(CASE)).toBe(`/cases/${CASE}`);
    expect(digestItemHref('a/b')).toBe('/cases/a%2Fb');
  });
  it("asks for the caller's own digest unless viewing as someone", () => {
    expect(digestUrl(null)).toBe('/api/brain/digest');
    expect(digestUrl('')).toBe('/api/brain/digest');
    expect(digestUrl(CASE)).toBe(`/api/brain/digest?userId=${CASE}`);
  });
});

describe('viewAsOptions', () => {
  it('lists every live teammate but the viewer, by name', () => {
    expect(
      viewAsOptions(
        [
          { user_id: 'me', full_name: 'Aaron' },
          { user_id: 'u2', full_name: 'Zainab' },
          { user_id: 'u3', full_name: ' ', email: 'b@x.ae' },
          { user_id: 'u4', full_name: 'Gone', deactivated_at: '2026-01-01' },
          { user_id: 'u5', full_name: 'Mona' },
        ],
        'me'
      )
    ).toEqual([
      { userId: 'u3', name: 'b@x.ae' },
      { userId: 'u5', name: 'Mona' },
      { userId: 'u2', name: 'Zainab' },
    ]);
  });
});
