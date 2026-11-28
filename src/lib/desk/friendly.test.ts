import { describe, expect, it } from 'vitest';

import en from '../../../messages/en.json';

import {
  REASON_SENTENCE_CODES,
  caseBankView,
  fileSizeText,
  groupByDay,
  quickDocTypes,
  reasonSentence,
  resultLine,
  uploadButtonState,
  visibleUploadSteps,
  type UploadFormState,
} from './friendly';
import { DESK_REFUSALS, type ItemResult } from './store';

const NS = (en as Record<string, unknown>).DeskFriendly as Record<
  string,
  unknown
>;

function exists(key: string): boolean {
  const v = key
    .split('.')
    .reduce<unknown>(
      (o, k) =>
        o && typeof o === 'object'
          ? (o as Record<string, unknown>)[k]
          : undefined,
      NS
    );
  return typeof v === 'string';
}

describe('reasonSentence', () => {
  it('has a sentence for every intake_route reason and the refusals it names', () => {
    for (const code of REASON_SENTENCE_CODES) {
      const s = reasonSentence(code)!;
      expect(s.key).toBe(`reason.${code}`);
      expect(exists(s.key)).toBe(true);
    }
    // Refusal hints it lists are real desk refusals, not invented codes.
    const queueOnly = new Set([
      'NO_KIND',
      'NO_CASE',
      'BANK_MISMATCH',
      'CASE_EXISTS_NAME_MISMATCH',
      'CASE_OPEN_FAILED',
      'FILE_FAILED',
    ]);
    for (const code of REASON_SENTENCE_CODES)
      if (!queueOnly.has(code))
        expect(DESK_REFUSALS as readonly string[]).toContain(code);
  });

  it('names the uploader where the reason is what they left out', () => {
    expect(reasonSentence('NO_CASE', 'Omar')).toEqual({
      key: 'reasonBy.NO_CASE',
      values: { name: 'Omar' },
    });
    expect(exists('reasonBy.NO_CASE')).toBe(true);
    expect(exists('reasonBy.NO_KIND')).toBe(true);
    expect(exists('reasonBy.NO_CONTACT')).toBe(true);
    expect(exists('reasonBy.NO_FILE')).toBe(true);
    // Not their doing: no name.
    expect(reasonSentence('BANK_MISMATCH', 'Omar')).toEqual({
      key: 'reason.BANK_MISMATCH',
    });
    // A blank name reads as no name.
    expect(reasonSentence('NO_KIND', '  ')).toEqual({ key: 'reason.NO_KIND' });
  });

  it('reads an unknown code as a general sentence, never the code', () => {
    expect(reasonSentence('SOMETHING_NEW')).toEqual({ key: 'reason.OTHER' });
    expect(reasonSentence('SETTINGS_CHANGED', 'Omar')).toEqual({
      key: 'reason.OTHER',
    });
    expect(exists('reason.OTHER')).toBe(true);
  });

  it('says nothing when there is no reason', () => {
    expect(reasonSentence(null)).toBeNull();
    expect(reasonSentence('')).toBeNull();
  });
});

const FORM: UploadFormState = {
  kind: 'pending_doc',
  fileCount: 1,
  foundCaseNumber: null,
  busy: false,
  caseRef: '4271RAKD',
  caption: '',
  newCaseMissing: [],
};

describe('uploadButtonState', () => {
  it('blocks a pending document without its file, and says so', () => {
    const s = uploadButtonState({ ...FORM, fileCount: 0 });
    expect(s.disabled).toBe(true);
    expect(s.missingKey).toBe('missing.file');
    expect(exists(s.missingKey!)).toBe(true);
  });

  it('blocks nothing else: an incomplete upload waits to be sorted', () => {
    for (const kind of ['', 'info', 'new_case'] as const) {
      const s = uploadButtonState({
        ...FORM,
        kind,
        fileCount: 0,
        caseRef: '',
        newCaseMissing: ['company'],
      });
      expect(s.disabled).toBe(false);
      expect(s.missingKey).toBeNull();
    }
  });

  it('names the action, the count and the found case', () => {
    expect(
      uploadButtonState({ ...FORM, foundCaseNumber: 'TC-26-04271-RAK' })
    ).toMatchObject({
      labelKey: 'button.uploadTo',
      values: { count: 1, caseNumber: 'TC-26-04271-RAK' },
    });
    expect(uploadButtonState(FORM)).toMatchObject({
      labelKey: 'button.upload',
      values: { count: 1 },
    });
    expect(
      uploadButtonState({ ...FORM, kind: 'new_case', fileCount: 0 })
    ).toMatchObject({ labelKey: 'button.newCase', values: { count: 0 } });
    expect(
      uploadButtonState({ ...FORM, kind: 'info', fileCount: 0 })
    ).toMatchObject({ labelKey: 'button.info', values: { count: 0 } });
    expect(
      uploadButtonState({ ...FORM, kind: 'info', foundCaseNumber: 'X-1' })
    ).toMatchObject({ labelKey: 'button.infoTo' });
    expect(uploadButtonState({ ...FORM, busy: true })).toMatchObject({
      labelKey: 'button.uploading',
      disabled: true,
      missingKey: null,
    });
    for (const k of [
      'button.upload',
      'button.uploadTo',
      'button.newCase',
      'button.info',
      'button.infoTo',
      'button.uploading',
    ])
      expect(exists(k)).toBe(true);
  });

  it('warns when the upload will wait, unless a caption may fill it', () => {
    expect(uploadButtonState({ ...FORM, kind: '' }).waitKey).toBe(
      'wait.noKind'
    );
    expect(uploadButtonState({ ...FORM, caseRef: ' ' }).waitKey).toBe(
      'wait.noCase'
    );
    expect(
      uploadButtonState({
        ...FORM,
        kind: 'new_case',
        newCaseMissing: ['bank'],
      }).waitKey
    ).toBe('wait.newCaseIncomplete');
    expect(uploadButtonState({ ...FORM, kind: 'new_case' }).waitKey).toBeNull();
    expect(
      uploadButtonState({ ...FORM, kind: '', caption: '4271RAKD ejari' })
        .waitKey
    ).toBeNull();
    for (const k of ['wait.noKind', 'wait.noCase', 'wait.newCaseIncomplete'])
      expect(exists(k)).toBe(true);
  });
});

describe('visibleUploadSteps', () => {
  const none = { kind: '', step2HasValue: false, step3HasValue: false };
  it('reveals a step at a time and never hides a filled one', () => {
    expect(visibleUploadSteps({ ...none, showAll: false })).toBe(1);
    expect(visibleUploadSteps({ ...none, kind: 'info', showAll: false })).toBe(
      2
    );
    expect(
      visibleUploadSteps({
        ...none,
        kind: 'info',
        step2HasValue: true,
        showAll: false,
      })
    ).toBe(3);
    // A file or caption already there shows step 3 even with no kind.
    expect(
      visibleUploadSteps({ ...none, step3HasValue: true, showAll: false })
    ).toBe(3);
    expect(visibleUploadSteps({ ...none, showAll: true })).toBe(3);
  });
});

describe('caseBankView', () => {
  it('shows the found case bank read-only only when none was chosen', () => {
    expect(caseBankView({ foundBankCode: undefined, chosenBankCode: '' })).toBe(
      'select'
    );
    expect(caseBankView({ foundBankCode: 'RAK', chosenBankCode: '' })).toBe(
      'readonly'
    );
    expect(caseBankView({ foundBankCode: 'RAK', chosenBankCode: 'RAK' })).toBe(
      'select'
    );
    expect(caseBankView({ foundBankCode: 'RAK', chosenBankCode: 'ENBD' })).toBe(
      'mismatch'
    );
  });
});

describe('quickDocTypes', () => {
  const types = [
    { key: 'audit', label: 'Audit report' },
    { key: 'ejari', label: 'Ejari' },
    { key: 'other_a', label: 'Other A' },
    { key: 'passport', label: 'Passport' },
    { key: 'trade_licence', label: 'Trade licence' },
  ];
  it('puts the common types first, then the rest, at most max', () => {
    expect(quickDocTypes(types, '', 3).map((t) => t.key)).toEqual([
      'trade_licence',
      'passport',
      'ejari',
    ]);
    expect(quickDocTypes(types, '').map((t) => t.key)).toEqual([
      'trade_licence',
      'passport',
      'ejari',
      'audit',
      'other_a',
    ]);
  });
  it('keeps the chosen type among the chips', () => {
    expect(quickDocTypes(types, 'other_a', 3).map((t) => t.key)).toEqual([
      'trade_licence',
      'passport',
      'other_a',
    ]);
    expect(quickDocTypes([], 'x')).toEqual([]);
  });
});

describe('fileSizeText', () => {
  it('reads bytes, kilobytes and megabytes', () => {
    expect(fileSizeText(512)).toBe('512 byte');
    expect(fileSizeText(240 * 1024)).toBe('240 kB');
    expect(fileSizeText(3.44 * 1024 * 1024)).toBe('3.4 MB');
    expect(fileSizeText(-5)).toBe('0 byte');
  });
});

const ITEM: ItemResult = {
  itemId: 'i1',
  state: 'filed',
  caseId: 'c1',
  caseNumber: 'TC-26-04271-RAK',
  captionCode: '4271RAKD',
  fileId: 'f1',
  duplicateOfItem: null,
  queueBankCode: null,
  queueReason: null,
  replayed: false,
};

describe('resultLine', () => {
  it('says a new case was opened, with its code to copy', () => {
    const r = resultLine(ITEM, { kind: 'new_case' });
    expect(r).toMatchObject({
      key: 'result.newCase',
      values: { caseNumber: 'TC-26-04271-RAK', code: '4271RAKD' },
      tone: 'success',
    });
    expect(r.actions).toEqual(['copyCode', 'openCase']);
  });

  it('says where a document was filed, and as what', () => {
    expect(
      resultLine(ITEM, { kind: 'pending_doc', docTypeLabel: 'Ejari' })
    ).toMatchObject({
      key: 'result.filedAs',
      values: { caseNumber: 'TC-26-04271-RAK', docType: 'Ejari' },
    });
    expect(resultLine(ITEM, { kind: 'info' }).key).toBe('result.filed');
  });

  it('says which queue it went to, and why, with a way to fix it', () => {
    const r = resultLine(
      {
        ...ITEM,
        state: 'untagged',
        caseId: null,
        caseNumber: null,
        captionCode: null,
        queueBankCode: 'RAK',
        queueReason: 'CASE_NOT_FOUND',
      },
      { bankName: 'RAKBANK' }
    );
    expect(r).toMatchObject({
      key: 'result.queued',
      values: { bank: 'RAKBANK' },
      reason: { key: 'reason.CASE_NOT_FOUND' },
      tone: 'warning',
      actions: ['fixInMine'],
    });
    expect(
      resultLine({ ...ITEM, state: 'untagged', queueReason: 'NO_KIND' }).key
    ).toBe('result.queuedNoBank');
  });

  it('says a duplicate needs nothing more', () => {
    expect(resultLine({ ...ITEM, state: 'duplicate' })).toMatchObject({
      key: 'result.duplicate',
      tone: 'info',
    });
    expect(resultLine({ ...ITEM, state: 'rejected' }).actions).toEqual([]);
  });

  it('only asks for keys the catalogue has', () => {
    for (const k of [
      'result.newCase',
      'result.filed',
      'result.filedAs',
      'result.queued',
      'result.queuedNoBank',
      'result.duplicate',
      'result.rejected',
    ])
      expect(exists(k)).toBe(true);
  });
});

describe('groupByDay', () => {
  const now = new Date('2026-11-28T10:00:00Z'); // 14:00 in Dubai
  it('groups by the day in the given zone, newest first', () => {
    const items = [
      { id: 'a', receivedAt: '2026-11-28T09:00:00Z' },
      { id: 'b', receivedAt: '2026-11-27T21:00:00Z' }, // 01:00 on the 28th in Dubai
      { id: 'c', receivedAt: '2026-11-27T10:00:00Z' },
      { id: 'd', receivedAt: '2026-11-20T10:00:00Z' },
      { id: 'e', receivedAt: 'not a date' },
    ];
    const g = groupByDay(items, now, 'Asia/Dubai');
    expect(g.map((x) => [x.day, x.when, x.items.map((i) => i.id)])).toEqual([
      ['2026-11-28', 'today', ['a', 'b']],
      ['2026-11-27', 'yesterday', ['c']],
      ['2026-11-20', 'earlier', ['d']],
      ['', 'earlier', ['e']],
    ]);
    // The same instants in UTC fall on different days.
    expect(groupByDay(items.slice(0, 2), now, 'UTC').map((x) => x.day)).toEqual(
      ['2026-11-28', '2026-11-27']
    );
  });
});
