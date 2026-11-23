import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  aggregateCsat,
  asciiDigits,
  buildCsatText,
  csatBankProduct,
  csatFirstName,
  csatParams,
  CSAT_DEFAULTS,
  CSAT_TEMPLATE_BODIES,
  CSAT_TRIGGERS,
  CSAT_REQUEST_STATUSES,
  CSAT_CLAIM_LIMIT,
  CsatRefusal,
  csatTriggerFor,
  decideCsatSend,
  noteCsatReply,
  parseCsatReply,
  parseScoreRows,
  runCaseCsat,
  type CsatScoreRow,
} from './csat';
import { DEFAULT_STAGES, PRESUB_STAGES } from './ui';

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/246_case_csat.sql'),
  'utf8'
);

describe('parseCsatReply', () => {
  it.each([
    ['5', 5, null],
    [' 4 ', 4, null],
    ['5/5', 5, null],
    ['4 / 5', 4, null],
    ['3 out of 5', 3, null],
    ['5 stars', 5, null],
    ['1 star', 1, null],
    ['5 ⭐', 5, null],
    ['⭐⭐⭐⭐', 4, null],
    ['٥', 5, null],
    ['۴', 4, null],
    ['٣ نجوم', 3, null],
    ['4 من 5', 4, null],
    ['5.', 5, null],
    ['5!!', 5, null],
    ['5 😊👍🏽', 5, null],
    ['5️⃣', 5, null],
    ['4 of 5', 4, null],
    ['5 out of 5 stars', 5, null],
    ['5 - great', 5, 'great'],
    ['3: ok', 3, 'ok'],
    ['3; ok', 3, 'ok'],
    ['٤؛ جيد', 4, 'جيد'],
    ['5! thanks', 5, 'thanks'],
    ['2\ntoo slow\nreally', 2, 'too slow really'],
    ['4 من 5، جيد', 4, 'جيد'],
    ['5 stars great', 5, 'great'],
    ['5 out of 5 great', 5, 'great'],
    ['5 ⭐ great', 5, 'great'],
    ['⭐⭐⭐⭐⭐ great service', 5, 'great service'],
    ['⭐️ ⭐️', 2, null],
    ['2 - too slow', 2, 'too slow'],
    ['4/5 good but slow', 4, 'good but slow'],
    ['5, شكرا', 5, 'شكرا'],
  ])('%s -> %s', (text, score, comment) => {
    expect(parseCsatReply(text)).toEqual({ score, comment });
  });

  it.each([
    '',
    '   ',
    '0',
    '6',
    '10',
    '15',
    '5.5',
    '4,5',
    '1st',
    '5am',
    '+971501234567',
    '0501234567',
    'five',
    'hello 5',
    '⭐⭐⭐⭐⭐⭐',
    // Ordinary messages while a request is open.
    '5 great service',
    '5. Fast and clear',
    '2 years in business',
    '1. Passport 2. Trade licence',
    '3 pm call me',
    '2-3 years',
    '4 pm',
    '1) passport',
    '5 lakh',
    '3, 4 pm',
    '4 of 5 documents sent',
    '٢ سنوات',
    '5%',
    '1/5/2026',
    '1\n2\n3',
    '⭐⭐⭐ 5',
  ])('not a rating: %j', (text) => {
    expect(parseCsatReply(text)).toBeNull();
  });

  it('caps a comment at 1000 characters', () => {
    const r = parseCsatReply(`4, ${'a'.repeat(1010)}`);
    expect(r?.comment?.length).toBe(1000);
    expect(parseCsatReply(`4, ${'a'.repeat(2000)}`)).toBeNull();
  });

  it('reads Arabic-Indic digits as ASCII', () => {
    expect(asciiDigits('٠١٢٣٤٥٦٧٨٩ ۰۹')).toBe('0123456789 09');
  });
});

describe('csatTriggerFor (mirror of case_csat_trigger_for)', () => {
  it('asks on leaving the pre-submission stages', () => {
    expect(csatTriggerFor(null, 'Submitted')).toBe('submitted');
    expect(csatTriggerFor('Review', 'Submitted')).toBe('submitted');
    expect(csatTriggerFor('Interested', 'Bank acknowledged')).toBe('submitted');
    expect(csatTriggerFor(null, 'Bank custom stage')).toBe('submitted');
  });
  it('does not ask on later moves, pre-submission moves or other finals', () => {
    expect(csatTriggerFor('Submitted', 'Under review')).toBeNull();
    expect(csatTriggerFor('Interested', 'Review')).toBeNull();
    expect(csatTriggerFor(null, 'Interested')).toBeNull();
    expect(csatTriggerFor('Under review', 'Declined', 'Declined')).toBeNull();
    expect(csatTriggerFor('Review', 'Withdrawn')).toBeNull();
  });
  it('asks on approval, by stage or outcome', () => {
    expect(csatTriggerFor('Under review', 'Approved', 'Approved')).toBe(
      'approved'
    );
    expect(csatTriggerFor('Approved', 'Closed', 'Approved')).toBe('approved');
  });
  it('uses the pre-submission and final stages of 130 and 122', () => {
    expect(PRESUB_STAGES).toEqual(['Interested', 'Data collection', 'Review']);
    for (const s of ['Approved', 'Declined', 'Withdrawn', 'Closed'])
      expect(DEFAULT_STAGES).toContain(s);
    expect(SQL).toContain(
      "p_to NOT IN ('Approved', 'Declined', 'Withdrawn', 'Closed')"
    );
    expect(SQL).toContain(
      "WHEN p_to = 'Approved' OR p_outcome = 'Approved' THEN 'approved'"
    );
  });
});

describe('pinned to migration 246', () => {
  it('status list equals the CHECK', () => {
    const m =
      /case_csat_requests_status_check\s+CHECK \(status IN \(([^)]*)\)\)/.exec(
        SQL
      );
    const list = m![1]!.split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(list).toEqual([...CSAT_REQUEST_STATUSES]);
  });
  it('defaults equal the column defaults', () => {
    const def = (col: string) =>
      new RegExp(`\\n\\s+${col}\\s+[a-z]+ NOT NULL DEFAULT ([^,\\n]+),`).exec(
        SQL
      )?.[1];
    expect(def('enabled')).toBe(String(CSAT_DEFAULTS.enabled));
    expect(def('ask_on_submitted')).toBe(String(CSAT_DEFAULTS.askOnSubmitted));
    expect(def('ask_on_approved')).toBe(String(CSAT_DEFAULTS.askOnApproved));
    expect(def('template_submitted')).toBe(
      `'${CSAT_DEFAULTS.templateSubmitted}'`
    );
    expect(def('template_approved')).toBe(
      `'${CSAT_DEFAULTS.templateApproved}'`
    );
    expect(def('language')).toBe(`'${CSAT_DEFAULTS.language}'`);
    expect(def('reply_window_days')).toBe(
      String(CSAT_DEFAULTS.replyWindowDays)
    );
    expect(def('send_start_hour')).toBe(String(CSAT_DEFAULTS.sendStartHour));
    expect(def('send_end_hour')).toBe(String(CSAT_DEFAULTS.sendEndHour));
  });
});

describe('the request text', () => {
  const base = {
    contactName: 'Asha Rao',
    bankName: 'Emirates NBD',
    product: 'Business account',
    language: 'en',
  };
  it('is the coordinator-approved wording, filled in', () => {
    expect(buildCsatText({ ...base, trigger: 'submitted' })).toBe(
      'Hi Asha, your Emirates NBD business account application has been submitted to the bank. How happy are you with our service so far? Reply with a number from 1 (not happy) to 5 (very happy).'
    );
    expect(buildCsatText({ ...base, trigger: 'approved' })).toBe(
      'Hi Asha, good news: your Emirates NBD business account has been approved! How would you rate our service? Reply with a number from 1 (not happy) to 5 (very happy).'
    );
  });
  it('pins the template bodies with {{1}} and {{2}}', () => {
    for (const lang of ['en', 'ar'] as const)
      for (const trig of CSAT_TRIGGERS) {
        const body = CSAT_TEMPLATE_BODIES[lang][trig];
        expect(body).toContain('{{1}}');
        expect(body).toContain('{{2}}');
        expect(body).toContain('1');
        expect(body).toContain('5');
      }
  });
  it('falls back to a neutral word for a name that is a number', () => {
    expect(csatFirstName('+971 50 123', 'en')).toBe('there');
    expect(csatFirstName(null, 'en')).toBe('there');
    expect(csatFirstName('محمد علي', 'ar')).toBe('محمد');
    expect(csatFirstName('971501234567', 'ar')).toBe('عميلنا العزيز');
  });
  it('names bank and product, without a doubled "account" on approval', () => {
    expect(csatBankProduct('submitted', 'RAKBANK', 'Personal loan')).toBe(
      'RAKBANK personal loan'
    );
    expect(csatBankProduct('approved', 'RAKBANK', 'Current Account')).toBe(
      'RAKBANK current'
    );
    expect(csatBankProduct('approved', 'RAKBANK', null)).toBe('RAKBANK');
    expect(csatBankProduct('submitted', null, null)).toBe('bank');
    expect(
      csatParams({ ...base, trigger: 'approved', language: 'ar' })
    ).toEqual(['Asha', 'Emirates NBD business']);
  });
  it('writes Arabic for an ar language code', () => {
    const ar = buildCsatText({
      ...base,
      trigger: 'approved',
      language: 'ar_AE',
    });
    expect(ar).toContain('Emirates NBD business');
    expect(ar.startsWith('مرحبًا Asha')).toBe(true);
  });
});

describe('decideCsatSend', () => {
  it('sends text on a linked-device number', () => {
    for (const provider of ['whapi', 'openwa'] as const)
      expect(
        decideCsatSend({ provider, windowOpen: false, templateApproved: false })
      ).toBe('text');
  });
  it('on Meta: text in the window, the template outside, else held', () => {
    expect(
      decideCsatSend({
        provider: 'meta',
        windowOpen: true,
        templateApproved: false,
      })
    ).toBe('text');
    expect(
      decideCsatSend({
        provider: 'meta',
        windowOpen: false,
        templateApproved: true,
      })
    ).toBe('template');
    expect(
      decideCsatSend({
        provider: 'meta',
        windowOpen: false,
        templateApproved: false,
      })
    ).toBe('hold');
  });
});

describe('aggregateCsat', () => {
  const row = (
    score: number,
    agentId: string | null,
    bankCode: string | null,
    bankName: string | null = bankCode
  ): CsatScoreRow => ({
    caseId: 'c',
    trigger: 'submitted',
    agentId,
    bankCode,
    bankName,
    score,
  });
  it('is empty with no ratings', () => {
    expect(aggregateCsat([])).toEqual({
      overall: null,
      byAgent: [],
      byBank: [],
    });
  });
  it('averages overall, per agent and per bank to one decimal', () => {
    const a = aggregateCsat([
      row(5, 'a1', 'RAK', 'RAKBANK'),
      row(4, 'a1', 'ENBD', 'Emirates NBD'),
      row(4, 'a2', 'RAK', 'RAKBANK'),
      row(2, null, null, null),
      row(9, 'a1', 'RAK'),
    ]);
    expect(a.overall).toEqual({ average: 3.8, count: 4 });
    expect(a.byAgent).toEqual([
      { key: 'a1', label: null, average: 4.5, count: 2 },
      { key: 'a2', label: null, average: 4, count: 1 },
      { key: null, label: null, average: 2, count: 1 },
    ]);
    expect(a.byBank[0]).toEqual({
      key: 'RAK',
      label: 'RAKBANK',
      average: 4.5,
      count: 2,
    });
    expect(a.byBank.map((b) => b.key)).toEqual(['RAK', 'ENBD', null]);
  });
  it('reads RPC rows defensively', () => {
    expect(parseScoreRows(null)).toEqual([]);
    expect(
      parseScoreRows([
        {
          case_id: 'c1',
          trigger: 'approved',
          agent_id: 'u',
          bank_code: 'RAK',
          bank_name: 'RAKBANK',
          score: 5,
        },
        { case_id: 1, score: 5 },
        { case_id: 'c2', score: 'x' },
      ])
    ).toEqual([
      {
        caseId: 'c1',
        trigger: 'approved',
        agentId: 'u',
        bankCode: 'RAK',
        bankName: 'RAKBANK',
        score: 5,
      },
    ]);
  });
});

describe('runCaseCsat', () => {
  const claimRow = (id: string) => ({
    id,
    account_id: 'acc',
    case_id: 'case',
    trigger: 'approved',
    contact_id: 'ct',
    conversation_id: 'cv',
    contact_name: 'Asha',
    bank_name: 'RAKBANK',
    product: 'Business account',
    template_name: 'case_csat_approved',
    language: 'en',
  });
  function db(rows: unknown[]) {
    const rpc = vi.fn(async (...a: [fn: string, args?: unknown]) =>
      a[0] === 'case_csat_claim'
        ? { data: rows, error: null }
        : { data: true, error: null }
    );
    return { rpc } as unknown as Parameters<typeof runCaseCsat>[0] & {
      rpc: typeof rpc;
    };
  }

  it('marks each claim once: sent, held or failed (code only)', async () => {
    const d = db([claimRow('1'), claimRow('2'), claimRow('3'), claimRow('4')]);
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'sent',
        via: 'text',
        providerMessageId: 'wa1',
        messageId: 'm1',
      })
      .mockResolvedValueOnce({ outcome: 'held', reason: 'awaiting_template' })
      .mockRejectedValueOnce(new CsatRefusal('invalid_number'))
      .mockRejectedValueOnce(new Error('secret +971 text'));
    const s = await runCaseCsat(
      d,
      send,
      () => new Date('2026-11-22T08:00:00Z')
    );
    expect(s).toEqual({ claimed: 4, sent: 1, held: 1, failed: 2 });
    const marks = d.rpc.mock.calls.filter((c) => c[0] === 'case_csat_mark');
    expect(
      marks.map((c) => (c[1] as Record<string, unknown>).p_outcome)
    ).toEqual(['sent', 'held', 'failed', 'failed']);
    expect((marks[0]![1] as Record<string, unknown>).p_via).toBe('text');
    expect((marks[1]![1] as Record<string, unknown>).p_reason).toBe(
      'awaiting_template'
    );
    expect((marks[2]![1] as Record<string, unknown>).p_reason).toBe(
      'invalid_number'
    );
    expect((marks[3]![1] as Record<string, unknown>).p_reason).toBe('error');
    expect(send.mock.calls[0]![1]).toMatchObject({
      id: '1',
      trigger: 'approved',
      bankName: 'RAKBANK',
    });
  });

  it('claims at most 5 per pass', async () => {
    const d = db([]);
    await runCaseCsat(d, vi.fn());
    expect(CSAT_CLAIM_LIMIT).toBe(5);
    expect(d.rpc.mock.calls[0]![1]).toMatchObject({ p_limit: 5 });
  });

  it('never throws', async () => {
    const d = {
      rpc: vi.fn(async () => ({ data: null, error: { code: 'XX' } })),
    } as unknown as Parameters<typeof runCaseCsat>[0];
    expect(await runCaseCsat(d, vi.fn())).toBeNull();
  });
});

describe('noteCsatReply', () => {
  const input = {
    accountId: 'a',
    contactId: 'c',
    messageRowId: 'm',
  };
  it('costs nothing for a message that is not a rating', async () => {
    const rpc = vi.fn();
    expect(
      await noteCsatReply({ rpc } as never, { ...input, text: 'hi' })
    ).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('sends score and comment, and reports a capture', async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    expect(
      await noteCsatReply({ rpc } as never, { ...input, text: '4, good' })
    ).toBe(true);
    expect(rpc).toHaveBeenCalledWith('case_csat_capture', {
      p_account: 'a',
      p_contact: 'c',
      p_message: 'm',
      p_score: 4,
      p_comment: 'good',
    });
  });
  it('never throws', async () => {
    const rpc = vi.fn(async () => {
      throw new Error('down');
    });
    expect(await noteCsatReply({ rpc } as never, { ...input, text: '5' })).toBe(
      false
    );
    const err = vi.fn(async () => ({ data: null, error: { code: 'x' } }));
    expect(
      await noteCsatReply({ rpc: err } as never, { ...input, text: '5' })
    ).toBe(false);
  });
});

describe('the inbound pipeline', () => {
  it('tries a rating only after Flows, and only when no Flow took the message', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/lib/whatsapp/inbound-pipeline.ts'),
      'utf8'
    );
    const flows = src.indexOf('await dispatchInboundToFlows(');
    const calls = [...src.matchAll(/noteCsatReply\(/g)];
    expect(calls).toHaveLength(1);
    expect(flows).toBeGreaterThan(-1);
    expect(calls[0]!.index).toBeGreaterThan(flows);
    expect(src).toMatch(
      /const csatConsumed =\s+!flowConsumed &&\s+!interactiveReplyId &&\s+\(await noteCsatReply\(/
    );
  });
});
