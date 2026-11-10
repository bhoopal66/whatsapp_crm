import { describe, expect, it } from 'vitest';

import { FINAL_STAGES } from '@/lib/cases/settings-ui';
import { PRESUB_STAGES } from '@/lib/cases/ui';

import {
  DEFAULT_NAME_PATTERN,
  caseFilesErrorKey,
  caseFilesSettingsBody,
  isNamePattern,
  parseCaseFilesSettings,
  parseFileSpec,
  readyStageOptions,
  specBody,
  specDraft,
  specRowsFromDraft,
  validateReadyStages,
  validateSpecRows,
  type CaseFilesSettings,
  type SpecRow,
} from './settings-view';

const OFF: CaseFilesSettings = {
  checklistSync: false,
  readyMove: false,
  readyFromStage: null,
  readyToStage: null,
  intakePrompts: false,
};

describe('parseCaseFilesSettings', () => {
  it('reads the caseFiles object of a GET answer', () => {
    const body = {
      settings: { managedExternally: false, submissionWhatsappGroups: true },
      caseFiles: {
        checklistSync: true,
        readyMove: true,
        readyFromStage: 'Documents requested',
        readyToStage: 'Documents received',
        intakePrompts: false,
      },
    };
    expect(parseCaseFilesSettings(body)).toEqual({
      checklistSync: true,
      readyMove: true,
      readyFromStage: 'Documents requested',
      readyToStage: 'Documents received',
      intakePrompts: false,
    });
  });

  it('reads missing stages as null', () => {
    expect(
      parseCaseFilesSettings({
        caseFiles: {
          checklistSync: false,
          readyMove: false,
          intakePrompts: false,
        },
      })
    ).toEqual(OFF);
  });

  it.each([
    null,
    'x',
    [],
    {},
    { caseFiles: null },
    { caseFiles: [] },
    { caseFiles: { ...OFF, checklistSync: 'yes' } },
    { caseFiles: { readyMove: false, intakePrompts: false } },
    { caseFiles: { ...OFF, readyFromStage: 3 } },
    { caseFiles: { ...OFF, readyToStage: '  ' } },
  ])('refuses junk %#', (body) => {
    expect(parseCaseFilesSettings(body)).toBeNull();
  });
});

describe('caseFilesSettingsBody', () => {
  it('is null when nothing changed', () => {
    expect(caseFilesSettingsBody(OFF, { ...OFF })).toBeNull();
  });

  it('sends only the switches that changed', () => {
    expect(caseFilesSettingsBody(OFF, { ...OFF, checklistSync: true })).toEqual(
      { caseFiles: { checklistSync: true } }
    );
    expect(
      caseFilesSettingsBody(
        { ...OFF, intakePrompts: true, checklistSync: true },
        { ...OFF, intakePrompts: false, checklistSync: true }
      )
    ).toEqual({ caseFiles: { intakePrompts: false } });
  });

  it('sends both stages whenever either changed', () => {
    const saved = {
      ...OFF,
      readyMove: true,
      readyFromStage: 'Submitted',
      readyToStage: 'Documents received',
    };
    expect(
      caseFilesSettingsBody(saved, { ...saved, readyToStage: 'Under review' })
    ).toEqual({
      caseFiles: { readyFromStage: 'Submitted', readyToStage: 'Under review' },
    });
    expect(
      caseFilesSettingsBody(OFF, {
        ...OFF,
        readyMove: true,
        readyFromStage: 'Submitted',
        readyToStage: 'Under review',
      })
    ).toEqual({
      caseFiles: {
        readyMove: true,
        readyFromStage: 'Submitted',
        readyToStage: 'Under review',
      },
    });
  });

  it('clears both stages together', () => {
    const saved = {
      ...OFF,
      readyFromStage: 'Submitted',
      readyToStage: 'Under review',
    };
    expect(
      caseFilesSettingsBody(saved, {
        ...saved,
        readyFromStage: null,
        readyToStage: null,
      })
    ).toEqual({ caseFiles: { readyFromStage: null, readyToStage: null } });
  });
});

describe('readyStageOptions', () => {
  it('leaves out the pre-submission and final stages, in order', () => {
    const options = readyStageOptions();
    expect(options).toEqual([
      'Submitted',
      'Bank acknowledged',
      'Documents requested',
      'Documents received',
      'Under review',
      'Query raised',
      'Query answered',
    ]);
    for (const s of [...PRESUB_STAGES, ...FINAL_STAGES])
      expect(options).not.toContain(s);
  });

  it('drops a final stage whatever its case', () => {
    expect(readyStageOptions(['Interested', 'A', 'approved', 'B'])).toEqual([
      'A',
      'B',
    ]);
  });
});

describe('validateReadyStages', () => {
  it('accepts a pair in order, and none while the move is off', () => {
    expect(validateReadyStages('Submitted', 'Under review', true)).toBeNull();
    expect(validateReadyStages(null, null, false)).toBeNull();
  });

  it('needs both stages, and needs them when the move is on', () => {
    expect(validateReadyStages(null, null, true)).toBe('incomplete');
    expect(validateReadyStages('Submitted', null, false)).toBe('incomplete');
    expect(validateReadyStages(null, 'Submitted', false)).toBe('incomplete');
  });

  it('refuses presub, final and unknown stages', () => {
    expect(validateReadyStages('Review', 'Submitted', true)).toBe(
      'notSelectable'
    );
    expect(validateReadyStages('Submitted', 'Approved', true)).toBe(
      'notSelectable'
    );
    expect(validateReadyStages('Submitted', 'Nope', true)).toBe(
      'notSelectable'
    );
  });

  it('refuses equal and out-of-order pairs', () => {
    expect(validateReadyStages('Submitted', 'Submitted', true)).toBe('same');
    expect(validateReadyStages('Under review', 'Submitted', true)).toBe(
      'order'
    );
  });
});

const REQS = [
  { docKey: 'passport', label: 'Passport' },
  { docKey: 'salary', label: 'Salary certificate' },
];

const row = (over: Partial<SpecRow> = {}): SpecRow => ({
  docKey: 'passport',
  position: 1,
  namePattern: DEFAULT_NAME_PATTERN,
  required: true,
  maxMb: 10,
  allowedMime: ['application/pdf'],
  minValidDays: null,
  merged: true,
  ...over,
});

describe('parseFileSpec', () => {
  it('reads a GET answer and drops junk rows', () => {
    const view = parseFileSpec({
      product: 'Card',
      requirements: [...REQS, null, { label: 'no key' }],
      rows: [
        row(),
        { docKey: 'salary', position: 'x' },
        7,
        {
          ...row({ docKey: 'salary', position: 2 }),
          allowedMime: ['image/png', 4],
        },
      ],
      usesDefaults: false,
    });
    expect(view).toEqual({
      product: 'Card',
      requirements: REQS,
      rows: [
        row(),
        row({ docKey: 'salary', position: 2, allowedMime: ['image/png'] }),
      ],
      usesDefaults: false,
    });
  });

  it('labels a requirement with no label by its key', () => {
    expect(
      parseFileSpec({ product: 'P', requirements: [{ docKey: 'a' }], rows: [] })
        ?.requirements
    ).toEqual([{ docKey: 'a', label: 'a' }]);
  });

  it.each([
    null,
    [],
    { requirements: [], rows: [] },
    { product: 'P', requirements: {}, rows: [] },
    { product: 'P', requirements: [], rows: null },
  ])('refuses junk %#', (body) => {
    expect(parseFileSpec(body)).toBeNull();
  });
});

describe('specDraft / specRowsFromDraft', () => {
  it('starts from 181 defaults when no spec is stored', () => {
    const draft = specDraft({
      product: 'Card',
      requirements: REQS,
      rows: [],
      usesDefaults: true,
    });
    expect(draft.merged).toBe(true);
    expect(specRowsFromDraft(draft)).toEqual([
      row({ allowedMime: ['application/pdf', 'image/jpeg', 'image/png'] }),
      row({
        docKey: 'salary',
        position: 2,
        allowedMime: ['application/pdf', 'image/jpeg', 'image/png'],
      }),
    ]);
  });

  it('keeps stored rows, drops one for a document no longer listed', () => {
    const draft = specDraft({
      product: 'Card',
      requirements: [REQS[0]],
      rows: [
        row({ position: 5, minValidDays: 30, merged: false }),
        row({ docKey: 'gone', position: 6, merged: false }),
      ],
      usesDefaults: false,
    });
    expect(draft.merged).toBe(false);
    expect(specRowsFromDraft(draft)).toEqual([
      row({ position: 5, minValidDays: 30, merged: false }),
    ]);
  });

  it('turns typed junk into NaN and blank days into no minimum', () => {
    const [r] = specRowsFromDraft({
      merged: true,
      rows: [
        {
          docKey: 'passport',
          label: 'Passport',
          position: '1.5',
          namePattern: 'x',
          required: false,
          maxMb: '',
          allowedMime: ['image/png', 'application/pdf'],
          minValidDays: ' ',
        },
      ],
    });
    expect(r.position).toBeNaN();
    expect(r.maxMb).toBeNaN();
    expect(r.minValidDays).toBeNull();
    expect(r.allowedMime).toEqual(['application/pdf', 'image/png']);
  });
});

describe('validateSpecRows', () => {
  const ok = [row(), row({ docKey: 'salary', position: 2 })];

  it('accepts a valid spec and the empty reset', () => {
    expect(validateSpecRows(ok, REQS)).toBeNull();
    expect(validateSpecRows([], REQS)).toBeNull();
  });

  it('takes doc keys from the requirements only, once each', () => {
    expect(validateSpecRows([row({ docKey: 'visa' })], REQS)).toEqual({
      kind: 'unknownDoc',
      docKey: 'visa',
    });
    expect(validateSpecRows([row(), row({ position: 2 })], REQS)).toEqual({
      kind: 'duplicateDoc',
      docKey: 'passport',
    });
  });

  it.each([0, -1, 1.5, NaN, 1_000_000_000])('refuses position %s', (p) => {
    expect(validateSpecRows([row({ position: p })], REQS)?.kind).toBe(
      'position'
    );
  });

  it('accepts the largest position and refuses a repeated one', () => {
    expect(validateSpecRows([row({ position: 999_999_999 })], REQS)).toBeNull();
    expect(validateSpecRows([row(), row({ docKey: 'salary' })], REQS)).toEqual({
      kind: 'duplicatePosition',
      position: 1,
    });
  });

  it.each([0, 101, 2.5, NaN])('refuses max MB %s', (m) => {
    expect(validateSpecRows([row({ maxMb: m })], REQS)?.kind).toBe('maxMb');
  });

  it('accepts max MB 1 and 100', () => {
    expect(validateSpecRows([row({ maxMb: 1 })], REQS)).toBeNull();
    expect(validateSpecRows([row({ maxMb: 100 })], REQS)).toBeNull();
  });

  it.each([[[]], [['image/gif']], [['application/pdf', 'application/pdf']]])(
    'refuses allowed types %j',
    (allowedMime) => {
      expect(validateSpecRows([row({ allowedMime })], REQS)?.kind).toBe('mime');
    }
  );

  it.each([-1, 3651, 1.5, NaN])('refuses min valid days %s', (d) => {
    expect(validateSpecRows([row({ minValidDays: d })], REQS)?.kind).toBe(
      'minValidDays'
    );
  });

  it('accepts min valid days 0, 3650 and none', () => {
    for (const d of [0, 3650, null])
      expect(validateSpecRows([row({ minValidDays: d })], REQS)).toBeNull();
  });

  it('checks the name pattern', () => {
    expect(isNamePattern('{{company}} - {{doc}} {{yyyymmdd}}{{case}}')).toBe(
      true
    );
    expect(isNamePattern('x'.repeat(200))).toBe(true);
    for (const bad of ['', '  ', 'x'.repeat(201), '{{name}}', '{{doc', 'a}}'])
      expect(validateSpecRows([row({ namePattern: bad })], REQS)?.kind).toBe(
        'namePattern'
      );
  });

  it('needs one merged value for every row', () => {
    expect(
      validateSpecRows(
        [row(), row({ docKey: 'salary', position: 2, merged: false })],
        REQS
      )
    ).toEqual({ kind: 'merged' });
  });
});

describe('specBody / caseFilesErrorKey', () => {
  it('builds the PUT body, empty for a reset', () => {
    expect(specBody('Card', [row()])).toEqual({
      product: 'Card',
      rows: [row()],
    });
    expect(specBody('Card', [])).toEqual({ product: 'Card', rows: [] });
  });

  it('maps refusal codes to message keys', () => {
    expect(caseFilesErrorKey({ code: 'SPEC_INVALID' }, 422)).toBe(
      'specInvalid'
    );
    expect(caseFilesErrorKey({ code: 'DOCS_INVALID' }, 422)).toBe(
      'docsInvalid'
    );
    expect(caseFilesErrorKey({ code: 'BANK_UNKNOWN' }, 422)).toBe(
      'bankUnknown'
    );
    expect(caseFilesErrorKey({ code: 'SETTING_INVALID' }, 422)).toBe(
      'settingInvalid'
    );
    expect(caseFilesErrorKey({ error: 'Forbidden' }, 403)).toBe('notAllowed');
    expect(caseFilesErrorKey(null, 500)).toBe('generic');
  });
});
