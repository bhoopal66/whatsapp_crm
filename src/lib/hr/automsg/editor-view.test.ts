import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AutoMsgTemplateView } from './api';
import {
  EDITOR_MESSAGE_KEYS,
  editorCounter,
  editorInitial,
  editorMessages,
  editorPayload,
  editorSlots,
  editorView,
  rcsTemplateIdProblem,
  saveRefusalMessage,
  smsBodyMeasure,
  smsLabelProblem,
  SMS_NAME_ALLOWANCE,
  type EditorForm,
} from './editor-view';
import { SEED_TEMPLATES } from './templates';

const stored = (
  over: Partial<AutoMsgTemplateView> = {}
): AutoMsgTemplateView => ({
  kind: 'hr_interview_invite',
  language: 'en',
  channel: 'whatsapp',
  body: 'Hi {name}, your HR interview is on {slot}.',
  metaTemplateName: 'hr_invite_v2',
  approvalStatus: 'approved',
  category: 'utility',
  updatedAt: '2026-11-16T08:00:00Z',
  ...over,
});

const form = (over: Partial<EditorForm> = {}): EditorForm => ({
  body: 'Hello {name}, we would like to invite you to an HR interview on {slot}.',
  metaTemplateName: 'hr_hr_interview_invite',
  approvalStatus: 'draft',
  category: 'utility',
  ...over,
});

describe('editorInitial / editorSlots', () => {
  it('falls back to the seed text as a draft when nothing is stored', () => {
    expect(editorInitial('cv_ack', 'ar', null)).toEqual({
      body: SEED_TEMPLATES.cv_ack.text.ar,
      metaTemplateName: 'hr_cv_ack',
      approvalStatus: 'draft',
      category: 'utility',
    });
  });

  it('uses the stored row over the seed', () => {
    expect(editorInitial('hr_interview_invite', 'en', stored())).toEqual({
      body: 'Hi {name}, your HR interview is on {slot}.',
      metaTemplateName: 'hr_invite_v2',
      approvalStatus: 'approved',
      category: 'utility',
    });
  });

  it('gives one slot per kind x language in order, keyed by the stored values', () => {
    const slots = editorSlots([stored()]);
    expect(slots).toHaveLength(12);
    expect(slots.slice(0, 2).map((s) => [s.kind, s.language])).toEqual([
      ['cv_ack', 'en'],
      ['cv_ack', 'ar'],
    ]);
    const hr = slots.find(
      (s) => s.kind === 'hr_interview_invite' && s.language === 'en'
    )!;
    expect(hr.stored).not.toBeNull();
    expect(hr.initial.body).toBe('Hi {name}, your HR interview is on {slot}.');
    const after = editorSlots([stored({ body: 'Hi {name}, at {slot}.' })]);
    const hr2 = after.find(
      (s) => s.kind === 'hr_interview_invite' && s.language === 'en'
    )!;
    expect(hr2.key).not.toBe(hr.key);
    // an unrelated slot keeps its key
    expect(after[0].key).toBe(slots[0].key);
  });
});

describe('editorMessages', () => {
  it('passes the seed text', () => {
    expect(editorMessages('hr_interview_invite', form())).toEqual([]);
  });

  it('names a missing placeholder', () => {
    expect(
      editorMessages('hr_interview_invite', form({ body: 'Hello {name}.' }))
    ).toEqual([{ key: 'missingPlaceholder', values: { slot: '{slot}' } }]);
  });

  it('quotes the promotional phrase', () => {
    expect(
      editorMessages(
        'cv_ack',
        form({ body: 'Hello {name}, visit our website for a discount.' })
      )
    ).toEqual([{ key: 'promotional', values: { phrase: 'discount' } }]);
  });

  it('flags other invalid bodies, and length past the cap', () => {
    expect(
      editorMessages('cv_ack', form({ body: 'Hi {name} {other}' }))
    ).toEqual([{ key: 'invalid', values: { name: '{name}', slot: '{slot}' } }]);
    expect(
      editorMessages('cv_ack', form({ body: `{name} ${'a'.repeat(1030)}` }))
    ).toEqual([{ key: 'tooLong', values: { max: 1024 } }]);
  });

  it('needs a Meta template name when approved, in Meta format', () => {
    expect(
      editorMessages(
        'hr_interview_invite',
        form({ approvalStatus: 'approved', metaTemplateName: '  ' })
      )
    ).toEqual([{ key: 'approvedNeedsName' }]);
    expect(
      editorMessages(
        'hr_interview_invite',
        form({ approvalStatus: 'draft', metaTemplateName: '' })
      )
    ).toEqual([]);
    expect(
      editorMessages(
        'hr_interview_invite',
        form({ metaTemplateName: 'HR-Invite' })
      )
    ).toEqual([{ key: 'nameFormat' }]);
  });
});

describe('editorView', () => {
  it('counts characters', () => {
    expect(editorCounter('abc')).toEqual({ count: 3, max: 1024 });
  });

  it('lets an admin save a valid form only', () => {
    expect(editorView('hr_interview_invite', form(), 'admin').canSave).toBe(
      true
    );
    expect(
      editorView('hr_interview_invite', form(), 'admin', true).canSave
    ).toBe(false);
    const noName = form({ approvalStatus: 'approved', metaTemplateName: '' });
    expect(editorView('hr_interview_invite', noName, 'admin').canSave).toBe(
      false
    );
  });

  it('shows leads the fields read-only, with no save', () => {
    const v = editorView('hr_interview_invite', form(), 'lead');
    expect(v.readOnly).toBe(true);
    expect(v.canSave).toBe(false);
    expect(editorView('hr_interview_invite', form(), null).readOnly).toBe(true);
  });

  it('trims the name in the payload', () => {
    expect(
      editorPayload('cv_ack', 'en', form({ metaTemplateName: ' hr_cv_ack ' }))
        .metaTemplateName
    ).toBe('hr_cv_ack');
  });
});

describe('RCS templates', () => {
  const rcsRow = stored({
    channel: 'rcs',
    body: 'Hi {name}, RCS invite for {slot}.',
    metaTemplateName: 'prov:invite.v1',
    updatedAt: '2026-11-19T08:00:00Z',
  });

  it('never fills a WhatsApp slot with an RCS row', () => {
    const slots = editorSlots([rcsRow]);
    const hr = slots.find(
      (s) => s.kind === 'hr_interview_invite' && s.language === 'en'
    )!;
    expect(hr.stored).toBeNull();
    expect(hr.channel).toBe('whatsapp');
    expect(hr.key).toBe('hr_interview_invite|en|seed');
    expect(hr.initial).toEqual(
      editorInitial('hr_interview_invite', 'en', null)
    );
    // ...whichever order the config lists the two rows in
    for (const list of [
      [rcsRow, stored()],
      [stored(), rcsRow],
    ]) {
      const wa = editorSlots(list).find(
        (s) => s.kind === 'hr_interview_invite' && s.language === 'en'
      )!;
      expect(wa.stored?.channel).toBe('whatsapp');
      expect(wa.initial.metaTemplateName).toBe('hr_invite_v2');
    }
  });

  it('gives RCS slots their own rcs| keys and stored RCS rows only', () => {
    const slots = editorSlots([stored(), rcsRow], 'rcs');
    expect(slots).toHaveLength(12);
    expect(slots.every((s) => s.channel === 'rcs')).toBe(true);
    expect(slots.every((s) => s.key.startsWith('rcs|'))).toBe(true);
    const hr = slots.find(
      (s) => s.kind === 'hr_interview_invite' && s.language === 'en'
    )!;
    expect(hr.stored).toBe(rcsRow);
    expect(hr.initial).toEqual({
      body: 'Hi {name}, RCS invite for {slot}.',
      metaTemplateName: 'prov:invite.v1',
      approvalStatus: 'approved',
      category: 'utility',
    });
    const waKeys = new Set(editorSlots([stored(), rcsRow]).map((s) => s.key));
    expect(slots.some((s) => waKeys.has(s.key))).toBe(false);
  });

  it('starts an unsaved RCS editor from the WhatsApp text, else the seed', () => {
    const fromWa = editorSlots([stored()], 'rcs').find(
      (s) => s.kind === 'hr_interview_invite' && s.language === 'en'
    )!;
    expect(fromWa.stored).toBeNull();
    expect(fromWa.initial).toEqual({
      body: 'Hi {name}, your HR interview is on {slot}.',
      metaTemplateName: '',
      approvalStatus: 'draft',
      category: 'utility',
    });
    expect(editorInitial('cv_ack', 'ar', null, 'rcs').body).toBe(
      SEED_TEMPLATES.cv_ack.text.ar
    );
    // a saved WhatsApp row re-initialises the unsaved RCS editor
    const later = editorSlots(
      [stored({ updatedAt: '2026-11-20T08:00:00Z' })],
      'rcs'
    ).find((s) => s.kind === 'hr_interview_invite' && s.language === 'en')!;
    expect(later.key).not.toBe(fromWa.key);
  });

  it('checks the provider id, not the Meta name, on RCS', () => {
    expect(rcsTemplateIdProblem('', 'approved')).toBe('rcsApprovedNeedsId');
    expect(rcsTemplateIdProblem('  ', 'approved')).toBe('rcsApprovedNeedsId');
    expect(rcsTemplateIdProblem('', 'draft')).toBeNull();
    expect(rcsTemplateIdProblem('Prov:Invite.v1-2_a', 'approved')).toBeNull();
    expect(rcsTemplateIdProblem('has space', 'draft')).toBe('rcsIdFormat');
    expect(rcsTemplateIdProblem('x'.repeat(513), 'draft')).toBe('rcsIdFormat');
    expect(rcsTemplateIdProblem('x'.repeat(512), 'approved')).toBeNull();

    const f = form({ metaTemplateName: 'Prov:Invite.v1' });
    expect(editorMessages('hr_interview_invite', f, 'rcs')).toEqual([]);
    expect(editorMessages('hr_interview_invite', f)).toEqual([
      { key: 'nameFormat' },
    ]);
    expect(
      editorMessages(
        'hr_interview_invite',
        form({ approvalStatus: 'approved', metaTemplateName: '' }),
        'rcs'
      )
    ).toEqual([{ key: 'rcsApprovedNeedsId' }]);
    // body rules are the same
    expect(
      editorMessages(
        'hr_interview_invite',
        form({ body: 'Hello {name}.', metaTemplateName: 'a b' }),
        'rcs'
      )
    ).toEqual([
      { key: 'missingPlaceholder', values: { slot: '{slot}' } },
      { key: 'rcsIdFormat' },
    ]);
  });

  it('lets the same people save, and names the channel in the payload', () => {
    const f = form({ metaTemplateName: '' });
    expect(
      editorView('hr_interview_invite', f, 'admin', false, 'rcs').canSave
    ).toBe(true);
    const lead = editorView('hr_interview_invite', f, 'lead', false, 'rcs');
    expect(lead.readOnly).toBe(true);
    expect(lead.canSave).toBe(false);
    expect(
      editorPayload('cv_ack', 'en', form({ metaTemplateName: ' p.1 ' }), 'rcs')
    ).toEqual({
      kind: 'cv_ack',
      language: 'en',
      body: form().body,
      metaTemplateName: 'p.1',
      approvalStatus: 'draft',
      category: 'utility',
      channel: 'rcs',
    });
    expect(editorPayload('cv_ack', 'en', form())).not.toHaveProperty('channel');
  });
});

describe('SMS templates', () => {
  const smsRow = stored({
    channel: 'sms',
    body: 'Hi {name}, SMS invite for {slot}.',
    metaTemplateName: 'hr-invite.sms',
    updatedAt: '2026-11-21T08:00:00Z',
  });
  const rcsRow = stored({
    channel: 'rcs',
    body: 'Hi {name}, RCS invite for {slot}.',
    metaTemplateName: 'prov:invite.v1',
  });

  it('gives SMS slots their own sms| keys and stored SMS rows only', () => {
    const slots = editorSlots([stored(), rcsRow, smsRow], 'sms');
    expect(slots).toHaveLength(12);
    expect(slots.every((s) => s.channel === 'sms')).toBe(true);
    expect(slots.every((s) => s.key.startsWith('sms|'))).toBe(true);
    const hr = slots.find(
      (s) => s.kind === 'hr_interview_invite' && s.language === 'en'
    )!;
    expect(hr.stored).toBe(smsRow);
    const otherKeys = new Set([
      ...editorSlots([stored(), rcsRow, smsRow]).map((s) => s.key),
      ...editorSlots([stored(), rcsRow, smsRow], 'rcs').map((s) => s.key),
    ]);
    expect(slots.some((s) => otherKeys.has(s.key))).toBe(false);
    // an SMS row never fills a WhatsApp or RCS slot
    for (const ch of ['whatsapp', 'rcs'] as const) {
      const slot = editorSlots([smsRow], ch).find(
        (s) => s.kind === 'hr_interview_invite' && s.language === 'en'
      )!;
      expect(slot.stored).toBeNull();
    }
  });

  it('starts an unsaved SMS editor from the WhatsApp text, with no label', () => {
    const fromWa = editorSlots([stored(), rcsRow], 'sms').find(
      (s) => s.kind === 'hr_interview_invite' && s.language === 'en'
    )!;
    expect(fromWa.stored).toBeNull();
    expect(fromWa.initial).toEqual({
      body: 'Hi {name}, your HR interview is on {slot}.',
      metaTemplateName: '',
      approvalStatus: 'draft',
      category: 'utility',
    });
    expect(editorInitial('cv_ack', 'ar', null, 'sms').body).toBe(
      SEED_TEMPLATES.cv_ack.text.ar
    );
  });

  it('checks the label on SMS: needed to approve, in the label characters', () => {
    expect(smsLabelProblem('', 'approved')).toBe('smsApprovedNeedsLabel');
    expect(smsLabelProblem('  ', 'approved')).toBe('smsApprovedNeedsLabel');
    expect(smsLabelProblem('', 'draft')).toBeNull();
    expect(smsLabelProblem('HR-invite.sms:1_a', 'approved')).toBeNull();
    expect(smsLabelProblem('cv ack', 'draft')).toBe('smsLabelFormat');
    expect(smsLabelProblem('x'.repeat(513), 'draft')).toBe('smsLabelFormat');
    expect(
      editorMessages(
        'hr_interview_invite',
        form({ approvalStatus: 'approved', metaTemplateName: '' }),
        'sms'
      )
    ).toEqual([{ key: 'smsApprovedNeedsLabel' }]);
    expect(
      editorMessages(
        'hr_interview_invite',
        form({ metaTemplateName: 'HR-invite.SMS' }),
        'sms'
      )
    ).toEqual([]);
  });

  it('counts the SMS as it would be sent, not the raw placeholders', () => {
    // '{' is outside the GSM alphabet: the raw body would read as Unicode.
    const m = smsBodyMeasure('Hi {name}, see you at {slot}.');
    expect(m.encoding).toBe('gsm-7bit');
    expect(m.length).toBe(
      'Hi , see you at a time we will confirm shortly.'.length +
        SMS_NAME_ALLOWANCE
    );
    expect(m.segments).toBe(1);
    expect(smsBodyMeasure('مرحبا {name}').encoding).toBe('unicode');
    expect(smsBodyMeasure('a'.repeat(460)).fits).toBe(false);

    const v = editorView('cv_ack', form(), 'admin', false, 'sms');
    expect(v.sms).toMatchObject({ encoding: 'gsm-7bit', fits: true });
    expect(editorView('cv_ack', form(), 'admin').sms).toBeNull();
    expect(editorView('cv_ack', form(), 'admin', false, 'rcs').sms).toBeNull();
  });

  it('names the channel in the payload; leads stay read-only', () => {
    expect(
      editorPayload('cv_ack', 'en', form({ metaTemplateName: ' l.1 ' }), 'sms')
    ).toMatchObject({ metaTemplateName: 'l.1', channel: 'sms' });
    const lead = editorView('cv_ack', form(), 'lead', false, 'sms');
    expect([lead.readOnly, lead.canSave]).toEqual([true, false]);
  });
});

describe('labels', () => {
  const catalogue = (file: string) =>
    JSON.parse(readFileSync(join(process.cwd(), 'messages', file), 'utf8')).Hr
      .automsg.templates;

  it.each(['en.json', 'ko.json'])('%s has every check message', (file) => {
    const t = catalogue(file);
    for (const k of EDITOR_MESSAGE_KEYS) expect(t.check[k]).toBeTruthy();
  });
});

describe('saveRefusalMessage', () => {
  it("337's TEMPLATE_PROMOTIONAL shows the editor's promotional message", () => {
    expect(
      saveRefusalMessage('TEMPLATE_PROMOTIONAL', 'Hi {name}, apply now!')
    ).toEqual({
      key: 'templates.check.promotional',
      values: { phrase: 'apply now' },
    });
  });

  it('any other code is its error key', () => {
    expect(saveRefusalMessage('STALE', 'x')).toEqual({ key: 'error.STALE' });
    expect(saveRefusalMessage('CLOSED', 'x')).toEqual({
      key: 'error.UNKNOWN',
    });
  });
});
