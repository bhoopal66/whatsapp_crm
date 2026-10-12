import { describe, expect, it } from 'vitest';

import {
  parseSettingsInput,
  type DealRoomSettings,
  type InviteTemplateStatus,
} from './settings';
import {
  draftBody,
  draftFrom,
  isDirty,
  parseSettingsView,
  saveErrorText,
  statusLines,
  templateLine,
  type DealRoomSettingsView,
  type SettingsDraft,
} from './settings-ui';

const settings = (over: Partial<DealRoomSettings> = {}): DealRoomSettings => ({
  inviteTemplateName: null,
  inviteTemplateLanguage: 'en',
  inviteTemplateNameAr: null,
  updatedAt: null,
  ...over,
});

const status = (
  over: Partial<InviteTemplateStatus> = {}
): InviteTemplateStatus => ({
  name: 'group_invite',
  language: 'en',
  found: true,
  status: 'APPROVED',
  ready: true,
  ...over,
});

const view = (
  over: Partial<DealRoomSettingsView> = {}
): DealRoomSettingsView => ({
  settings: settings(),
  metaNumber: true,
  template: null,
  templateAr: null,
  ...over,
});

const draft = (over: Partial<SettingsDraft> = {}): SettingsDraft => ({
  name: '',
  language: 'en',
  nameAr: '',
  ...over,
});

describe('parseSettingsView', () => {
  it('reads the route answer', () => {
    const json = {
      settings: {
        inviteTemplateName: 'group_invite',
        inviteTemplateLanguage: 'en_US',
        inviteTemplateNameAr: 'group_invite_ar',
        updatedAt: '2026-10-12T08:00:00Z',
      },
      metaNumber: true,
      template: status({ language: 'en_US' }),
      templateAr: status({
        name: 'group_invite_ar',
        language: 'ar',
        status: 'PENDING',
        ready: false,
      }),
    };
    expect(parseSettingsView(json)).toEqual({
      settings: {
        inviteTemplateName: 'group_invite',
        inviteTemplateLanguage: 'en_US',
        inviteTemplateNameAr: 'group_invite_ar',
        updatedAt: '2026-10-12T08:00:00Z',
      },
      metaNumber: true,
      template: status({ language: 'en_US' }),
      templateAr: {
        name: 'group_invite_ar',
        language: 'ar',
        found: true,
        status: 'PENDING',
        ready: false,
      },
    });
  });

  it('falls back to the defaults for what is missing or mistyped', () => {
    expect(
      parseSettingsView({
        settings: {
          inviteTemplateName: 7,
          inviteTemplateLanguage: '',
          inviteTemplateNameAr: {},
        },
        metaNumber: 'yes',
        template: { name: 'x' },
      })
    ).toEqual({
      settings: {
        inviteTemplateName: null,
        inviteTemplateLanguage: 'en',
        inviteTemplateNameAr: null,
        updatedAt: null,
      },
      metaNumber: false,
      template: null,
      templateAr: null,
    });
  });

  it('refuses an answer without settings', () => {
    for (const bad of [null, undefined, 'x', 3, [], {}, { settings: [] }]) {
      expect(parseSettingsView(bad)).toBeNull();
    }
  });
});

describe('saveErrorText', () => {
  it("is the route's error", () => {
    expect(saveErrorText({ error: ' Language must be a code ' }, 400)).toBe(
      'Language must be a code'
    );
  });

  it('is the HTTP status when the answer has no usable error', () => {
    for (const json of [null, {}, { error: '' }, { error: 5 }, 'oops']) {
      expect(saveErrorText(json, 502)).toBe('HTTP 502');
    }
  });
});

describe('draft', () => {
  it('starts from the saved settings', () => {
    expect(draftFrom(settings())).toEqual({
      name: '',
      language: 'en',
      nameAr: '',
    });
    expect(
      draftFrom(
        settings({
          inviteTemplateName: 'group_invite',
          inviteTemplateLanguage: 'en_US',
          inviteTemplateNameAr: 'group_invite_ar',
        })
      )
    ).toEqual({
      name: 'group_invite',
      language: 'en_US',
      nameAr: 'group_invite_ar',
    });
  });

  it('sends names trimmed, blank ones cleared and a blank language as the default', () => {
    expect(
      draftBody({ name: '  group_invite ', language: ' en_US ', nameAr: ' ' })
    ).toEqual({
      inviteTemplateName: 'group_invite',
      inviteTemplateLanguage: 'en_US',
      inviteTemplateNameAr: null,
    });
    expect(draftBody({ name: '', language: '  ', nameAr: '' })).toEqual({
      inviteTemplateName: null,
      inviteTemplateLanguage: 'en',
      inviteTemplateNameAr: null,
    });
  });

  it('builds a body the route accepts, to the columns it names', () => {
    const parsed = parseSettingsInput(
      draftBody({ name: ' group_invite', language: '', nameAr: 'invite_ar ' })
    );
    expect(parsed).toEqual({
      ok: true,
      value: {
        invite_template_name: 'group_invite',
        invite_template_language: 'en',
        invite_template_name_ar: 'invite_ar',
      },
    });
    // The empty draft clears both names; the route takes null for that.
    expect(parseSettingsInput(draftBody(draft()))).toEqual({
      ok: true,
      value: {
        invite_template_name: null,
        invite_template_language: 'en',
        invite_template_name_ar: null,
      },
    });
  });
});

describe('isDirty', () => {
  const saved = settings({
    inviteTemplateName: 'group_invite',
    inviteTemplateLanguage: 'en_US',
    inviteTemplateNameAr: 'group_invite_ar',
  });

  it('is false for the draft the settings produce', () => {
    expect(isDirty(draftFrom(saved), saved)).toBe(false);
    expect(isDirty(draftFrom(settings()), settings())).toBe(false);
  });

  it('ignores spaces and a blank language over the default', () => {
    expect(
      isDirty(
        { name: ' group_invite ', language: 'en_US ', nameAr: '' },
        {
          ...saved,
          inviteTemplateNameAr: null,
        }
      )
    ).toBe(false);
    expect(isDirty(draft({ language: '' }), settings())).toBe(false);
  });

  it('is true when any of the three changes', () => {
    const base = draftFrom(saved);
    expect(isDirty({ ...base, name: 'other_invite' }, saved)).toBe(true);
    expect(isDirty({ ...base, language: 'en' }, saved)).toBe(true);
    expect(isDirty({ ...base, nameAr: '' }, saved)).toBe(true);
    expect(isDirty(draft({ name: 'group_invite' }), settings())).toBe(true);
  });
});

describe('templateLine', () => {
  it('says ready only for a copy the route calls ready', () => {
    expect(templateLine('group_invite', status())).toEqual({
      kind: 'ready',
      tone: 'ok',
    });
  });

  it.each(['PENDING', 'IN_APPEAL', 'REJECTED', 'PAUSED', 'DISABLED', 'DRAFT'])(
    'is not ready for a %s copy, and names the status',
    (s) => {
      expect(
        templateLine('group_invite', status({ status: s, ready: false }))
      ).toEqual({ kind: 'notReady', tone: 'warn', status: s });
    }
  );

  it('trusts ready over the status text', () => {
    // Not synced from Meta's registry: APPROVED locally is not enough.
    expect(
      templateLine('group_invite', status({ status: 'APPROVED', ready: false }))
    ).toEqual({ kind: 'notFound', tone: 'warn' });
    expect(
      templateLine('group_invite', status({ status: 'PENDING', ready: false }))
        .kind
    ).not.toBe('ready');
  });

  it('says not found when no row has the name and language', () => {
    expect(
      templateLine(
        'group_invite',
        status({ found: false, status: null, ready: false })
      )
    ).toEqual({ kind: 'notFound', tone: 'warn' });
    expect(templateLine('group_invite', null)).toEqual({
      kind: 'notFound',
      tone: 'warn',
    });
  });

  it('keeps a dash where a found row has no status', () => {
    expect(
      templateLine('group_invite', status({ status: null, ready: false }))
    ).toEqual({ kind: 'notReady', tone: 'warn', status: '—' });
  });

  it('says not set when no name is saved, whatever a status says', () => {
    expect(templateLine(null, null)).toEqual({ kind: 'notSet', tone: 'warn' });
    expect(templateLine('', status())).toEqual({
      kind: 'notSet',
      tone: 'warn',
    });
  });
});

describe('statusLines', () => {
  const saved = settings({
    inviteTemplateName: 'group_invite',
    inviteTemplateLanguage: 'en_US',
    inviteTemplateNameAr: 'group_invite_ar',
  });
  const v = view({
    settings: saved,
    template: status({ language: 'en_US' }),
    templateAr: status({
      name: 'group_invite_ar',
      language: 'ar',
      status: 'PENDING',
      ready: false,
    }),
  });

  it('shows each saved copy while the boxes hold it', () => {
    expect(statusLines(v, draftFrom(saved))).toEqual({
      main: { kind: 'ready', tone: 'ok' },
      ar: { kind: 'notReady', tone: 'warn', status: 'PENDING' },
    });
    // A stray space is not an edit.
    expect(
      statusLines(v, { ...draftFrom(saved), name: 'group_invite ' }).main
    ).toEqual({ kind: 'ready', tone: 'ok' });
  });

  it('withdraws the default copy’s line once its name or language is edited', () => {
    const base = draftFrom(saved);
    expect(statusLines(v, { ...base, name: 'group_invite_2' }).main).toBeNull();
    expect(statusLines(v, { ...base, language: 'en' }).main).toBeNull();
    expect(statusLines(v, { ...base, name: '' }).main).toBeNull();
  });

  it('withdraws the Arabic line once its name is edited, not the other', () => {
    const base = draftFrom(saved);
    const edited = statusLines(v, { ...base, nameAr: 'new_ar' });
    expect(edited.ar).toBeNull();
    expect(edited.main).toEqual({ kind: 'ready', tone: 'ok' });
    // The language box belongs to the default copy only.
    expect(statusLines(v, { ...base, language: 'en' }).ar).toEqual({
      kind: 'notReady',
      tone: 'warn',
      status: 'PENDING',
    });
  });

  it('says not set under an empty default name, and nothing under an empty Arabic one', () => {
    expect(statusLines(view(), draft())).toEqual({
      main: { kind: 'notSet', tone: 'warn' },
      ar: null,
    });
    // Typing a first name: nothing has been checked yet.
    expect(
      statusLines(view(), draft({ name: 'group_invite' })).main
    ).toBeNull();
  });
});
