import { describe, expect, it } from 'vitest';

import {
  ANSWER_WINDOW_MS,
  KB_LEARN_DEFAULT_ENABLED,
  LEARNED_REF_PREFIX,
  buildLearnPrompt,
  cleanTopicLabel,
  isLearnableChat,
  isPersonReply,
  learnedRef,
  learnedReviewerNotes,
  maskNames,
  parseLearnedAnswer,
  pickTeamAnswer,
  redactEvidence,
  redactEvidenceText,
  wantsArabic,
  type ThreadMessage,
} from './learn';

const GAP_AT = '2026-11-10T10:00:00.000Z';
const at = (minutes: number) =>
  new Date(Date.parse(GAP_AT) + minutes * 60_000).toISOString();
const msg = (over: Partial<ThreadMessage>): ThreadMessage => ({
  sender_type: 'agent',
  sender_id: 'user-1',
  content_type: 'text',
  content_text: 'You need a trade licence.',
  template_name: null,
  created_at: at(5),
  ...over,
});

describe('defaults', () => {
  it('is off unless switched on (278)', () => {
    expect(KB_LEARN_DEFAULT_ENABLED).toBe(false);
  });
});

describe('isPersonReply', () => {
  it('takes a person’s plain text', () => {
    expect(isPersonReply(msg({}))).toBe(true);
  });
  it('refuses the customer, the bot, automations, templates and media', () => {
    expect(isPersonReply(msg({ sender_type: 'customer' }))).toBe(false);
    expect(isPersonReply(msg({ sender_type: 'bot' }))).toBe(false);
    expect(isPersonReply(msg({ sender_id: null }))).toBe(false);
    expect(isPersonReply(msg({ template_name: 'welcome' }))).toBe(false);
    expect(isPersonReply(msg({ content_type: 'image' }))).toBe(false);
    expect(isPersonReply(msg({ content_text: '   ' }))).toBe(false);
  });
});

describe('pickTeamAnswer', () => {
  it('takes the first person reply after the gap, passing over the rest', () => {
    const answer = msg({ created_at: at(30), content_text: 'the answer' });
    const picked = pickTeamAnswer(GAP_AT, [
      msg({ created_at: at(60), content_text: 'later reply' }),
      msg({ sender_type: 'bot', created_at: at(1) }),
      msg({ sender_type: 'customer', created_at: at(2) }),
      msg({ sender_id: null, created_at: at(3) }),
      answer,
    ]);
    expect(picked?.content_text).toBe('the answer');
  });
  it('ignores a reply before the question or after 48 hours', () => {
    expect(
      pickTeamAnswer(GAP_AT, [
        msg({ created_at: at(-5) }),
        msg({ created_at: GAP_AT }),
        msg({ created_at: at(ANSWER_WINDOW_MS / 60_000 + 1) }),
      ])
    ).toBeNull();
    expect(
      pickTeamAnswer(GAP_AT, [msg({ created_at: at(48 * 60) })])
    ).not.toBeNull();
  });
  it('answers null for a bad date', () => {
    expect(pickTeamAnswer('nope', [msg({})])).toBeNull();
  });
});

describe('isLearnableChat', () => {
  const open = { opted_out_at: null, do_not_contact_at: null };
  it('skips personal chats and opted-out or do-not-contact customers', () => {
    expect(isLearnableChat({ personal_owner_id: null }, open)).toBe(true);
    expect(isLearnableChat({ personal_owner_id: 'u' }, open)).toBe(false);
    expect(
      isLearnableChat(
        { personal_owner_id: null },
        { ...open, opted_out_at: GAP_AT }
      )
    ).toBe(false);
    expect(
      isLearnableChat(
        { personal_owner_id: null },
        { ...open, do_not_contact_at: GAP_AT }
      )
    ).toBe(false);
  });
});

describe('learnedRef', () => {
  it('matches 278’s ref check', () => {
    expect(learnedRef()).toMatch(/^LRN-[A-Z0-9]{8}$/);
    expect(learnedRef(() => 0)).toBe(`${LEARNED_REF_PREFIX}AAAAAAAA`);
    expect(learnedRef(() => 0.9999)).toBe(`${LEARNED_REF_PREFIX}99999999`);
  });
  it('differs between calls', () => {
    const refs = new Set(Array.from({ length: 50 }, () => learnedRef()));
    expect(refs.size).toBe(50);
  });
});

describe('maskNames', () => {
  it('masks each name word, whole words only, any case', () => {
    expect(
      maskNames('Hi Ahmed Khan, ahmed here. Ahmedabad branch', ['Ahmed Khan'])
    ).toBe('Hi [NAME] [NAME], [NAME] here. Ahmedabad branch');
  });
  it('masks Arabic names and ignores short words', () => {
    expect(maskNames('مرحبا محمد', ['محمد'])).toBe('مرحبا [NAME]');
    expect(maskNames('Al is here', ['Al'])).toBe('Al is here');
  });
});

describe('redactEvidenceText', () => {
  it('masks identifiers, names and long numbers', () => {
    const out = redactEvidenceText(
      'Sara, call +971 50 123 4567 or mail sara@example.com, IBAN AE070331234567890123456, ref 123456789012',
      ['Sara Ali']
    )!;
    expect(out).not.toMatch(/Sara|4567 |example\.com|AE0703|123456789012/);
    expect(out).toContain('[NAME]');
    expect(out).toContain('[EMAIL]');
  });
  it('fails closed on what it cannot screen', () => {
    expect(redactEvidenceText(42 as unknown as string)).toBeNull();
  });
  it('clips', () => {
    expect(redactEvidenceText('a '.repeat(2000))!.length).toBeLessThanOrEqual(
      800
    );
  });
});

describe('redactEvidence', () => {
  it('drops the whole set when one text cannot be screened', () => {
    const res = redactEvidence(
      {
        questions: [{ text: 'q1', names: [] }],
        answers: [{ text: 'bad', names: [] }],
      },
      (t) => (t === 'bad' ? null : t)
    );
    expect(res.ok).toBe(false);
  });
  it('caps questions and answers at five', () => {
    const res = redactEvidence({
      questions: Array.from({ length: 9 }, (_, i) => ({
        text: `q${i}`,
        names: [],
      })),
      answers: Array.from({ length: 9 }, (_, i) => ({
        text: `a${i}`,
        names: [],
      })),
    });
    expect(res.ok && res.evidence.questions.length).toBe(5);
    expect(res.ok && res.evidence.answers.length).toBe(5);
  });
});

describe('cleanTopicLabel', () => {
  it('redacts and flattens the label', () => {
    expect(cleanTopicLabel('  POS\nfor   my shop? call 0501234567 ')).toBe(
      'POS for my shop? call [PHONE:567]'
    );
    expect(cleanTopicLabel('   ')).toBeNull();
  });
});

describe('wantsArabic', () => {
  it('is true when any answer is mostly Arabic', () => {
    expect(wantsArabic(['Yes, you can.'])).toBe(false);
    expect(wantsArabic(['Yes', 'نعم يمكنك فتح الحساب'])).toBe(true);
  });
});

describe('buildLearnPrompt', () => {
  it('tells the model to answer generally, as JSON, and lists the evidence', () => {
    const p = buildLearnPrompt({
      topic: 'Trade licence',
      questions: ['Do I need one?'],
      answers: ['Yes, a valid licence.'],
      arabic: true,
    });
    expect(p.systemPrompt).toMatch(/general/i);
    expect(p.systemPrompt).toMatch(/Never include a person's name/);
    expect(p.systemPrompt).toContain('answer_ar');
    expect(p.userMessage).toContain('1. Do I need one?');
    expect(p.userMessage).toContain('1. Yes, a valid licence.');
    expect(
      buildLearnPrompt({
        topic: 'x',
        questions: [],
        answers: ['a'],
        arabic: false,
      }).systemPrompt
    ).not.toContain('answer_ar');
  });
});

describe('parseLearnedAnswer', () => {
  it('reads plain or fenced JSON', () => {
    expect(parseLearnedAnswer('{"answer_en":"Yes."}', false)).toEqual({
      answerEn: 'Yes.',
      answerAr: null,
    });
    expect(
      parseLearnedAnswer(
        '```json\n{"answer_en":"Yes.","answer_ar":"نعم."}\n```',
        true
      )
    ).toEqual({ answerEn: 'Yes.', answerAr: 'نعم.' });
    expect(
      parseLearnedAnswer('Sure! {"answer_en":"Yes."} done', false)
    ).toEqual({ answerEn: 'Yes.', answerAr: null });
  });
  it('drops Arabic when it was not asked for', () => {
    expect(
      parseLearnedAnswer('{"answer_en":"Yes.","answer_ar":"نعم."}', false)
    ).toEqual({ answerEn: 'Yes.', answerAr: null });
  });
  it('refuses junk, blanks and answers carrying an identifier or a mask', () => {
    expect(parseLearnedAnswer('not json', false)).toBeNull();
    expect(parseLearnedAnswer('{"answer_en":"  "}', false)).toBeNull();
    expect(
      parseLearnedAnswer('{"answer_en":"Call +971 50 123 4567."}', false)
    ).toBeNull();
    expect(
      parseLearnedAnswer('{"answer_en":"Ask [NAME] at the branch."}', false)
    ).toBeNull();
    expect(
      parseLearnedAnswer(
        '{"answer_en":"Fine.","answer_ar":"اتصل [PHONE:567]"}',
        true
      )
    ).toBeNull();
  });
  it('keeps a [TO CONFIRM] placeholder (081 refuses to approve it)', () => {
    expect(
      parseLearnedAnswer('{"answer_en":"The fee is [TO CONFIRM: fee]."}', false)
        ?.answerEn
    ).toContain('[TO CONFIRM');
  });
});

describe('learnedReviewerNotes', () => {
  it('names the count and the date range', () => {
    expect(
      learnedReviewerNotes(['2026-11-12T08:00:00Z', '2026-11-03T08:00:00Z'])
    ).toBe(
      'Drafted from 2 team replies, 2026-11-03 to 2026-11-12. Check before approving.'
    );
    expect(learnedReviewerNotes(['2026-11-03T08:00:00Z'])).toBe(
      'Drafted from 1 team reply, 2026-11-03. Check before approving.'
    );
  });
});
