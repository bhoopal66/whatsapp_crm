import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decide, inQuietHours, type DecideInput } from './guards';
import {
  PROMO_PHRASES_AR,
  PROMO_PHRASES_EN,
  SEED_TEMPLATES,
  TemplateParamError,
  promotionalPhrase,
  render,
  requiredPlaceholders,
  validateTemplateBody,
} from './templates';
import {
  DEFAULT_SETTINGS,
  HOLD_REASONS,
  STALE_REASONS,
  TEMPLATE_KINDS,
  TRIGGERS,
  type AutoMsgSettings,
  type StoredTemplate,
  type TemplateKind,
} from './types';

const NOW = new Date('2026-11-14T10:00:00Z'); // 14:00 Asia/Dubai
const ON: AutoMsgSettings = {
  ...DEFAULT_SETTINGS,
  killSwitch: false,
  triggers: Object.fromEntries(
    TRIGGERS.map((t) => [t, { enabled: true, templateKind: 'cv_ack' }])
  ),
};
const TPL: StoredTemplate = {
  kind: 'cv_ack',
  language: 'en',
  body: SEED_TEMPLATES.cv_ack.text.en,
  metaTemplateName: 'hr_cv_ack',
  approvalStatus: 'approved',
  category: 'utility',
};
const draft = { ...TPL, approvalStatus: 'draft' as const };

function input(
  over: Partial<DecideInput> = {},
  state: Partial<DecideInput['state']> = {}
): DecideInput {
  return {
    settings: ON,
    trigger: 'cv_received',
    template: TPL,
    now: NOW,
    duplicate: false,
    state: {
      stale: null,
      closed: false,
      optedOut: false,
      consent: true,
      lastInboundAt: '2026-11-14T09:00:00Z',
      sentToday: 0,
      ...state,
    },
    ...over,
  };
}
const why = (i: DecideInput) => {
  const d = decide(i);
  if (d.allow) return 'allow';
  return d.hold === null ? d.cancel : d.hold;
};

describe('automsg guards', () => {
  it('allows when every guard passes', () =>
    expect(decide(input())).toEqual({ allow: true }));

  it('defaults block: kill switch on, triggers disabled', () => {
    expect(
      why(input({ settings: { ...DEFAULT_SETTINGS, triggers: {} } }))
    ).toBe('kill_switch');
    expect(
      why(
        input({
          settings: { ...DEFAULT_SETTINGS, killSwitch: false, triggers: {} },
        })
      )
    ).toBe('disabled');
    expect(why(input({ triggerEnabled: false }))).toBe('disabled');
    expect(
      why(input({ settings: { ...ON, triggers: {} }, triggerEnabled: true }))
    ).toBe('allow');
  });

  it('produces every hold reason, each alone', () => {
    const quiet = new Date('2026-11-14T18:30:00Z'); // 22:30 Dubai
    const got = [
      why(input({ settings: { ...ON, killSwitch: true } })),
      why(input({ settings: { ...ON, triggers: {} } })),
      why(input({}, { closed: true })),
      why(input({}, { optedOut: true })),
      why(input({}, { consent: false })),
      why(input({ now: quiet })),
      why(input({ template: draft })),
      why(input({}, { sentToday: 3 })),
      why(input({ duplicate: true })),
    ];
    expect(got).toEqual([...HOLD_REASONS]);
  });

  it('checks in order: the earliest failing guard wins', () => {
    let cur = input(
      {
        settings: {
          ...ON,
          killSwitch: true,
          quietStart: '00:00',
          quietEnd: '23:59',
        },
        template: draft,
        duplicate: true,
      },
      {
        closed: true,
        optedOut: true,
        consent: false,
        lastInboundAt: null,
        sentToday: 9,
      }
    );
    const relax: Array<(i: DecideInput) => DecideInput> = [
      (i) => ({ ...i, settings: { ...i.settings, killSwitch: false } }),
      (i) => ({ ...i, state: { ...i.state, closed: false } }),
      (i) => ({ ...i, state: { ...i.state, optedOut: false } }),
      (i) => ({ ...i, state: { ...i.state, consent: true } }),
      (i) => ({
        ...i,
        settings: { ...i.settings, quietStart: '00:00', quietEnd: '00:00' },
      }),
      (i) => ({ ...i, template: TPL }),
      (i) => ({ ...i, state: { ...i.state, sentToday: 0 } }),
      (i) => ({ ...i, duplicate: false }),
    ];
    const order: string[] = [];
    for (const r of relax) {
      order.push(why(cur));
      cur = r(cur);
    }
    expect(why(cur)).toBe('allow');
    expect(order).toEqual(HOLD_REASONS.filter((h) => h !== 'disabled'));
  });

  it('consent is only needed when the workspace requires it', () => {
    expect(
      why(
        input(
          { settings: { ...ON, requiresConsent: false } },
          { consent: false }
        )
      )
    ).toBe('allow');
  });

  it('F5: a draft template is held inside and outside the 24h window; an approved one goes either way', () => {
    const w = 'outside_window_no_template';
    expect(why(input({ template: draft }))).toBe(w); // candidate wrote an hour ago
    expect(
      why(input({ template: draft }, { lastInboundAt: '2026-11-14T09:59:00Z' }))
    ).toBe(w);
    expect(
      why(input({ template: draft }, { lastInboundAt: '2026-11-13T10:00:01Z' }))
    ).toBe(w);
    expect(why(input({ template: draft }, { lastInboundAt: null }))).toBe(w);
    expect(why(input({}, { lastInboundAt: '2026-11-13T10:00:00Z' }))).toBe(
      'allow'
    );
    expect(why(input({}, { lastInboundAt: null }))).toBe('allow');
  });

  it('guard 7 also holds a missing, non-utility or invalid template', () => {
    const w = 'outside_window_no_template';
    expect(why(input({ template: null }))).toBe(w);
    expect(why(input({ template: { ...TPL, category: 'marketing' } }))).toBe(w);
    expect(why(input({ template: { ...TPL, body: 'Hello there' } }))).toBe(w);
    expect(
      why(
        input({ template: { ...TPL, body: `${TPL.body} Visit our website.` } })
      )
    ).toBe(w);
  });

  it('quiet hours: default 21:00-08:00 Dubai, edges and midnight wrap, configurable', () => {
    const at = (iso: string) => inQuietHours(new Date(iso), DEFAULT_SETTINGS);
    expect(at('2026-11-14T16:59:00Z')).toBe(false); // 20:59
    expect(at('2026-11-14T17:00:00Z')).toBe(true); // 21:00
    expect(at('2026-11-14T20:00:00Z')).toBe(true); // 00:00
    expect(at('2026-11-15T03:59:00Z')).toBe(true); // 07:59
    expect(at('2026-11-15T04:00:00Z')).toBe(false); // 08:00
    const day = { quietStart: '13:00', quietEnd: '15:00', tz: 'Asia/Dubai' };
    expect(inQuietHours(NOW, day)).toBe(true);
    expect(inQuietHours(NOW, { ...day, tz: 'UTC' })).toBe(false);
    expect(inQuietHours(NOW, { ...day, quietEnd: '13:00' })).toBe(false);
  });

  it('daily cap: default 3, configurable', () => {
    expect(why(input({}, { sentToday: 2 }))).toBe('allow');
    expect(why(input({}, { sentToday: 3 }))).toBe('daily_cap');
    expect(
      why(input({ settings: { ...ON, dailyCap: 1 } }, { sentToday: 1 }))
    ).toBe('daily_cap');
  });
});

describe('automsg templates', () => {
  it('six kinds, en and ar each, hr_ names, no {service}', () => {
    expect(TEMPLATE_KINDS).toHaveLength(6);
    for (const k of TEMPLATE_KINDS) {
      expect(SEED_TEMPLATES[k].text.en).toMatch(/\{name\}/);
      expect(SEED_TEMPLATES[k].text.ar).toMatch(/[؀-ۿ]/);
      expect(SEED_TEMPLATES[k].metaTemplateName).toMatch(/^hr_[a-z_]+$/);
      expect(SEED_TEMPLATES[k].text.en).not.toMatch(/\{service\}/);
    }
  });
  it('render fills placeholders and refuses missing, unknown, long or smuggling params', () => {
    expect(
      render('Hi {name} at {slot}', { name: 'Sara', slot: 'Mon 10:00' })
    ).toBe('Hi Sara at Mon 10:00');
    expect(() => render('Hi {name}', {})).toThrow(TemplateParamError);
    expect(() => render('Hi {name}', { name: 'A', text: 'free text' })).toThrow(
      TemplateParamError
    );
    expect(() => render('Hi {name}', { name: 'x'.repeat(81) })).toThrow(
      TemplateParamError
    );
    expect(() => render('Hi {name}', { name: 'A\nVisit evil' })).toThrow(
      TemplateParamError
    );
    expect(() => render('Hi {name}', { name: '{slot}' })).toThrow(
      TemplateParamError
    );
  });
});

const INVITE: TemplateKind[] = [
  'ai_interview_invite',
  'hr_interview_invite',
  'manager_interview_invite',
  'interview_reminder',
];

describe('validateTemplateBody: body rules (025b)', () => {
  it('every kind: en and ar seed bodies pass', () => {
    for (const k of TEMPLATE_KINDS)
      for (const l of ['en', 'ar'] as const)
        expect(
          validateTemplateBody(k, SEED_TEMPLATES[k].text[l]),
          `${k}/${l}`
        ).toBe('ok');
  });
  it('required placeholders come from the seed', () => {
    for (const k of TEMPLATE_KINDS)
      expect(requiredPlaceholders(k)).toContain('name');
    for (const k of INVITE) expect(requiredPlaceholders(k)).toContain('slot');
  });
  it('a body without {name}, or an invite without {slot}, is INVALID', () => {
    for (const k of TEMPLATE_KINDS)
      expect(
        validateTemplateBody(
          k,
          SEED_TEMPLATES[k].text.en.replaceAll('{name}', 'there')
        )
      ).toBe('INVALID');
    for (const k of INVITE)
      expect(
        validateTemplateBody(
          k,
          SEED_TEMPLATES[k].text.en.replaceAll('{slot}', 'soon')
        )
      ).toBe('INVALID');
  });
  it('unknown placeholder, braces, length and control characters are INVALID', () => {
    for (const k of TEMPLATE_KINDS) {
      const ok = SEED_TEMPLATES[k].text.en;
      for (const bad of [
        `${ok} {foo}`,
        `${ok} {service}`,
        `${ok} {`,
        `${ok} }`,
        `${ok} {{name}}`,
        `${ok} {na{me}}`,
        `${ok}${'x'.repeat(1024)}`,
        '',
        `${ok}\u0007`,
        `${ok}\n`,
      ])
        expect(validateTemplateBody(k, bad), JSON.stringify(bad)).toBe(
          'INVALID'
        );
    }
  });
  it('a body of exactly 1024 characters is accepted', () => {
    const base = SEED_TEMPLATES.cv_ack.text.en;
    expect(
      validateTemplateBody('cv_ack', base + 'x'.repeat(1024 - base.length))
    ).toBe('ok');
  });
});

describe('validateTemplateBody: category and promotional wording (027a)', () => {
  const body = (kind: TemplateKind, extra: string) =>
    `${SEED_TEMPLATES[kind].text.en} ${extra}`;
  it('marketing and authentication are refused for every kind; an unknown category is INVALID', () => {
    for (const k of TEMPLATE_KINDS)
      for (const c of ['marketing', 'authentication'] as const)
        expect(validateTemplateBody(k, SEED_TEMPLATES[k].text.en, c)).toBe(
          'CATEGORY_NOT_UTILITY'
        );
    expect(
      validateTemplateBody(
        'cv_ack',
        SEED_TEMPLATES.cv_ack.text.en,
        'promo' as never
      )
    ).toBe('INVALID');
  });
  it('category is checked before the body and the promo rule', () => {
    expect(validateTemplateBody('cv_ack', '', 'marketing')).toBe(
      'CATEGORY_NOT_UTILITY'
    );
    expect(
      validateTemplateBody(
        'cv_ack',
        body('cv_ack', 'special discount, visit https://x.com'),
        'marketing'
      )
    ).toBe('CATEGORY_NOT_UTILITY');
    expect(validateTemplateBody('cv_ack', 'discount {foo}')).toBe('INVALID');
  });
  const blockedEn: Array<[string, string]> = [
    ['discount', 'Get a 20% discount today.'],
    ['special offer', 'A special offer for you.'],
    ['special offer', 'Exclusive offers inside.'],
    ['sale', 'Our summer sale is on.'],
    ['sale', 'Items on sale now.'],
    ['free', 'Courses for free.'],
    ['free', 'Claim your free gift.'],
    ['promo', 'Use promo code HIRE.'],
    ['promo', 'This is a promotional note.'],
    ['limited time', 'Limited time only.'],
    ['apply now', 'Apply now for other jobs.'],
    ['other openings', 'See our other openings.'],
    ['other openings', 'We have other vacancies.'],
    ['visit our website', 'Visit our website for more.'],
    ['url', 'See https://x.com'],
    ['url', 'See http://x.com'],
    ['url', 'See www.x.com'],
    ['click here', 'Click HERE to book.'],
  ];
  it.each(blockedEn)('en: %s blocked in %s', (phrase, text) => {
    expect(promotionalPhrase(text)).toBe(phrase);
    expect(
      validateTemplateBody(
        'hr_interview_invite',
        body('hr_interview_invite', text)
      )
    ).toBe('PROMOTIONAL');
  });
  it('every documented phrase has a blocked example', () => {
    const covered = new Set(blockedEn.map(([p]) => p));
    for (const p of PROMO_PHRASES_EN)
      expect(covered.has(p.phrase), p.phrase).toBe(true);
  });
  it.each(PROMO_PHRASES_AR.map((p) => [p.phrase, p.text]))(
    'ar: %s blocked',
    (phrase, text) => {
      const ar = `${SEED_TEMPLATES.cv_ack.text.ar} ${text}`;
      expect(promotionalPhrase(ar)).toBe(phrase);
      expect(validateTemplateBody('cv_ack', ar)).toBe('PROMOTIONAL');
    }
  );
  it.each([
    'We are pleased to send you a job offer.',
    'Please sign your offer letter.',
    'Your offer of employment is attached.',
    'Feel free to reply with questions.',
    'Your interview for the Sales Executive role is confirmed.',
    'Congratulations on your promotion.',
    'The interview is free of travel; it is online.',
    'We will discuss the offer details.',
    'يسعدنا إرسال عرض العمل',
  ])('allowed: %s', (text) => {
    expect(promotionalPhrase(text)).toBeNull();
    expect(
      validateTemplateBody(
        'hr_interview_invite',
        body('hr_interview_invite', text)
      )
    ).toBe('ok');
  });
});

describe('a reason that no longer holds (migration 275)', () => {
  it('is cancelled with that reason, at night too', () => {
    const i = input();
    i.state.stale = 'stage_changed';
    i.settings = { ...i.settings, quietStart: '00:00', quietEnd: '23:59' };
    expect(decide(i)).toEqual({
      allow: false,
      hold: null,
      cancel: 'stage_changed',
    });
  });
  it('is only held while the kill switch is on', () => {
    const i = input();
    i.state.stale = 'no_longer_waiting';
    i.settings = { ...i.settings, killSwitch: true };
    expect(decide(i)).toEqual({ allow: false, hold: 'kill_switch' });
  });
  it('lists the reasons 275 answers, and no others', () => {
    const sql = readFileSync(
      'supabase/migrations/275_hr_automsg_still_true.sql',
      'utf8'
    );
    const found = [...sql.matchAll(/NULL ELSE '([a-z_]+)' END/g)].map(
      (m) => m[1]
    );
    expect(found).toEqual([...STALE_REASONS]);
  });
});
