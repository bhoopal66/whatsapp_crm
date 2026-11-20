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

describe('labels', () => {
  const catalogue = (file: string) =>
    JSON.parse(readFileSync(join(process.cwd(), 'messages', file), 'utf8')).Hr
      .automsg.templates;

  it.each(['en.json', 'ko.json'])('%s has every check message', (file) => {
    const t = catalogue(file);
    for (const k of EDITOR_MESSAGE_KEYS) expect(t.check[k]).toBeTruthy();
  });
});
