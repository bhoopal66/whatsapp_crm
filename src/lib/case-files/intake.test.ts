import { describe, expect, it } from 'vitest';
import {
  buildIntakeOptions,
  onCustomerGroupDocument,
  onCustomerGroupText,
  parseIntakeChoice,
  renderIntakeTemplate,
  type IntakeCaseInfo,
  type IntakeChecklistRow,
  type IntakeCheckResult,
  type IntakePorts,
  type IntakePrompt,
  type IntakeSendResult,
  type IntakeTemplateKind,
} from './intake';

const NOW = new Date('2026-11-10T22:30:00Z');
const CASE = 'case-1';
const GROUP = 'group-1';
const DOC = 'doc-1';

const WRITES = new Set([
  'register',
  'recordPrompt',
  'answerPrompt',
  'classifyAndCheck',
]);

interface Fake {
  ports: IntakePorts;
  calls: { name: string; args: unknown }[];
  names: () => string[];
  writes: () => string[];
  sends: () => string[];
  logs: { event: string; fields: Record<string, unknown> }[];
}

function fake(
  o: {
    info?: Partial<IntakeCaseInfo> | null;
    enabled?: boolean;
    templates?: Partial<Record<IntakeTemplateKind, string | null>>;
    mode?: 'group' | 'none' | null;
    checklist?: IntakeChecklistRow[];
    passed?: string[];
    send?: IntakeSendResult | 'throw';
    prompt?: IntakePrompt | null;
    answer?: { fileId: string; docKey: string } | { refuse: string };
    check?: IntakeCheckResult;
    ready?: boolean;
  } = {}
): Fake {
  const calls: Fake['calls'] = [];
  const logs: Fake['logs'] = [];
  const rec = (name: string, args: unknown = null) =>
    calls.push({ name, args });
  const templates: Record<IntakeTemplateKind, string | null> = {
    classify: 'Which document is {file}? Reply with its number:\n{list}',
    document_rejected: '{doc} failed: {checks}',
    document_received_next: 'Got {doc}. Still needed:\n{list}',
    ...o.templates,
  };
  const ports: IntakePorts = {
    caseInfo: async (id) => {
      rec('caseInfo', id);
      if (o.info === null) return null;
      return {
        accountId: 'acc-1',
        groupId: GROUP,
        coordinatorId: 'coord-1',
        closedAt: null,
        managedExternally: false,
        ...o.info,
      };
    },
    intakeEnabled: async (a) => {
      rec('intakeEnabled', a);
      return o.enabled ?? true;
    },
    approvedTemplate: async (a, kind) => {
      rec('approvedTemplate', kind);
      return templates[kind];
    },
    groupMode: async (g) => {
      rec('groupMode', g);
      return o.mode === undefined ? 'group' : o.mode;
    },
    register: async (c, d) => {
      rec('register', { c, d });
      return 'file-1';
    },
    checklist: async (c) => {
      rec('checklist', c);
      return (
        o.checklist ?? [
          {
            docKey: 'passport',
            position: 2,
            required: true,
            label: 'Passport',
          },
          { docKey: 'emirates_id', position: 1, required: true, label: null },
          {
            docKey: 'salary_cert',
            position: 3,
            required: true,
            label: 'Salary certificate',
          },
        ]
      );
    },
    passedDocKeys: async (c) => {
      rec('passedDocKeys', c);
      return o.passed ?? [];
    },
    send: async (input) => {
      rec('send', input);
      if (o.send === 'throw')
        throw Object.assign(new Error('x'), { reason: 'RATE' });
      return o.send ?? { sent: true, recorded: true };
    },
    recordPrompt: async (input) => {
      rec('recordPrompt', input);
    },
    openPrompt: async (c) => {
      rec('openPrompt', c);
      return o.prompt === undefined
        ? {
            id: 'prompt-1',
            fileId: 'file-1',
            options: [
              { n: 1, docKey: 'emirates_id', label: 'emirates id' },
              { n: 2, docKey: 'passport', label: 'Passport' },
            ],
          }
        : o.prompt;
    },
    answerPrompt: async (input) => {
      rec('answerPrompt', input);
      const a = o.answer ?? { fileId: 'file-1', docKey: 'passport' };
      if ('refuse' in a)
        throw Object.assign(new Error('refused'), { reason: a.refuse });
      return a;
    },
    classifyAndCheck: async (input) => {
      rec('classifyAndCheck', input);
      return o.check ?? { status: 'passed', checks: [] };
    },
    fileReady: async (c) => {
      rec('fileReady', c);
      return o.ready ?? false;
    },
    log: (event, fields) => logs.push({ event, fields }),
  };
  const names = () => calls.map((c) => c.name);
  return {
    ports,
    calls,
    names,
    writes: () => names().filter((n) => WRITES.has(n)),
    sends: () =>
      calls
        .filter((c) => c.name === 'send')
        .map((c) => (c.args as { text: string }).text),
    logs,
  };
}

const docInput = {
  caseId: CASE,
  groupId: GROUP,
  customerDocumentId: DOC,
  fileName: 'scan.pdf',
  now: NOW,
};

describe('onCustomerGroupDocument', () => {
  it('does nothing while the switch is off', async () => {
    const f = fake({ enabled: false });
    expect(await onCustomerGroupDocument(f.ports, docInput)).toBe('off');
    expect(f.writes()).toEqual([]);
    expect(f.sends()).toEqual([]);
    expect(f.names()).toEqual(['caseInfo', 'intakeEnabled']);
  });

  it('does nothing on a case Compass manages (134), switch on and wording approved', async () => {
    const f = fake({ info: { managedExternally: true } });
    expect(await onCustomerGroupDocument(f.ports, docInput)).toBe('off');
    expect(f.writes()).toEqual([]);
    expect(f.sends()).toEqual([]);
    expect(f.names()).not.toContain('register');
    expect(f.names()).not.toContain('classifyAndCheck');
  });

  it('does nothing while the classify wording is not approved', async () => {
    const f = fake({ templates: { classify: null } });
    expect(await onCustomerGroupDocument(f.ports, docInput)).toBe(
      'not_approved'
    );
    expect(f.writes()).toEqual([]);
    expect(f.sends()).toEqual([]);
  });

  it.each([
    ['no coordinator', { info: { coordinatorId: null } }, 'no_sender'],
    [
      'a closed case',
      { info: { closedAt: '2026-11-01T00:00:00Z' } },
      'case_closed',
    ],
    ['a group without WhatsApp', { mode: 'none' as const }, 'no_group'],
    ['a case on another group', { info: { groupId: 'group-2' } }, 'no_group'],
    ['no case', { info: null }, 'no_case'],
  ])('writes nothing for %s', async (_, opts, outcome) => {
    const f = fake(opts as Parameters<typeof fake>[0]);
    expect(await onCustomerGroupDocument(f.ports, docInput)).toBe(outcome);
    expect(f.writes()).toEqual([]);
    expect(f.sends()).toEqual([]);
  });

  it('logs ids and codes only', async () => {
    const f = fake({ info: { coordinatorId: null } });
    await onCustomerGroupDocument(f.ports, docInput);
    expect(f.logs).toEqual([
      {
        event: 'NO_SENDER',
        fields: { caseId: CASE, groupId: GROUP, customerDocumentId: DOC },
      },
    ]);
  });

  it('registers, sends as the coordinator, then records the prompt', async () => {
    const f = fake();
    expect(await onCustomerGroupDocument(f.ports, docInput)).toBe('prompted');
    const order = f
      .names()
      .filter((n) => ['register', 'send', 'recordPrompt'].includes(n));
    expect(order).toEqual(['register', 'send', 'recordPrompt']);
    expect(f.calls.find((c) => c.name === 'register')!.args).toEqual({
      c: CASE,
      d: DOC,
    });
    const send = f.calls.find((c) => c.name === 'send')!.args;
    expect(send).toEqual({
      accountId: 'acc-1',
      caseId: CASE,
      groupId: GROUP,
      coordinatorId: 'coord-1',
      text: 'Which document is scan.pdf? Reply with its number:\n1. emirates id\n2. Passport\n3. Salary certificate',
    });
    const record = f.calls.find((c) => c.name === 'recordPrompt')!.args as {
      fileId: string;
      options: unknown[];
      now: Date;
    };
    expect(record.fileId).toBe('file-1');
    expect(record.now).toBe(NOW);
    expect(record.options).toHaveLength(3);
  });

  it('names the file "your document" without a file name', async () => {
    const f = fake();
    await onCustomerGroupDocument(f.ports, {
      ...docInput,
      fileName: undefined,
    });
    expect(f.sends()[0]).toMatch(/^Which document is your document\?/);
  });

  it('records nothing when the send is refused', async () => {
    const f = fake({ send: { sent: false, code: 'SEND_NOT_ALLOWED' } });
    expect(await onCustomerGroupDocument(f.ports, docInput)).toBe('not_sent');
    expect(f.names()).not.toContain('recordPrompt');
  });

  it('records nothing when the send throws', async () => {
    const f = fake({ send: 'throw' });
    expect(await onCustomerGroupDocument(f.ports, docInput)).toBe('not_sent');
    expect(f.names()).not.toContain('recordPrompt');
  });

  it('records the prompt when the send went out but was not recorded', async () => {
    const f = fake({ send: { sent: true, recorded: false } });
    expect(await onCustomerGroupDocument(f.ports, docInput)).toBe('prompted');
    expect(f.names()).toContain('recordPrompt');
  });

  it('sends nothing when no required document is missing', async () => {
    const f = fake({ passed: ['passport', 'emirates_id', 'salary_cert'] });
    expect(await onCustomerGroupDocument(f.ports, docInput)).toBe('no_options');
    expect(f.sends()).toEqual([]);
    expect(f.names()).not.toContain('recordPrompt');
  });

  it('never throws when a port does', async () => {
    const f = fake();
    f.ports.register = async () => {
      throw new Error('db down');
    };
    expect(await onCustomerGroupDocument(f.ports, docInput)).toBe('error');
    expect(f.sends()).toEqual([]);
  });
});

describe('buildIntakeOptions', () => {
  it('excludes passed and optional docs, numbers in position order', () => {
    const opts = buildIntakeOptions(
      [
        { docKey: 'c', position: 3, required: true, label: 'C' },
        { docKey: 'a', position: 1, required: true, label: 'A' },
        { docKey: 'b', position: 2, required: true, label: 'B' },
        { docKey: 'opt', position: 0, required: false, label: 'Optional' },
        { docKey: 'bank_statement', position: 4, required: true, label: '  ' },
      ],
      ['b']
    );
    expect(opts).toEqual([
      { n: 1, docKey: 'a', label: 'A' },
      { n: 2, docKey: 'c', label: 'C' },
      { n: 3, docKey: 'bank_statement', label: 'bank statement' },
    ]);
  });

  it('caps at 20', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      docKey: `d${i}`,
      position: 25 - i,
      required: true,
      label: `D${i}`,
    }));
    const opts = buildIntakeOptions(rows, []);
    expect(opts).toHaveLength(20);
    expect(opts[0]).toEqual({ n: 1, docKey: 'd24', label: 'D24' });
    expect(opts[19].n).toBe(20);
  });
});

describe('parseIntakeChoice / renderIntakeTemplate', () => {
  it('accepts only a bare 1..20', () => {
    expect(parseIntakeChoice(' 3 ')).toBe(3);
    expect(parseIntakeChoice('20')).toBe(20);
    for (const s of ['21', '0', 'two', '3.', '1 2', '', '-1', '003']) {
      expect(parseIntakeChoice(s)).toBeNull();
    }
  });

  it('does not expand a placeholder inside a value', () => {
    expect(
      renderIntakeTemplate('{file} / {list}', { file: '{list}', list: 'L' })
    ).toBe('{list} / L');
  });
});

const textInput = (body: string) => ({ caseId: CASE, body, now: NOW });

describe('onCustomerGroupText', () => {
  it('does nothing while the switch is off, before reading the prompt', async () => {
    const f = fake({ enabled: false });
    expect(await onCustomerGroupText(f.ports, textInput('1'))).toBe('off');
    expect(f.names()).toEqual(['caseInfo', 'intakeEnabled']);
    expect(f.writes()).toEqual([]);
    expect(f.sends()).toEqual([]);
  });

  it('neither answers nor classifies on a case Compass manages (134)', async () => {
    const f = fake({ info: { managedExternally: true } });
    expect(await onCustomerGroupText(f.ports, textInput('1'))).toBe('off');
    expect(f.writes()).toEqual([]);
    expect(f.sends()).toEqual([]);
  });

  it.each(['hello', '21', '0', '1.5'])('ignores %j', async (body) => {
    const f = fake();
    expect(await onCustomerGroupText(f.ports, textInput(body))).toBe(
      'not_an_answer'
    );
    expect(f.names()).toEqual([]);
  });

  it('does nothing without an open prompt', async () => {
    const f = fake({ prompt: null });
    expect(await onCustomerGroupText(f.ports, textInput('1'))).toBe(
      'no_prompt'
    );
    expect(f.writes()).toEqual([]);
    expect(f.sends()).toEqual([]);
  });

  it.each(['PROMPT_STALE', 'PROMPT_OPTION', 'PROMPT_NOT_FOUND'])(
    'does nothing more on %s',
    async (reason) => {
      const f = fake({ answer: { refuse: reason } });
      expect(await onCustomerGroupText(f.ports, textInput('2'))).toBe(
        'answer_refused'
      );
      expect(f.names()).not.toContain('classifyAndCheck');
      expect(f.sends()).toEqual([]);
      expect(f.logs[0]).toEqual({
        event: 'PORT_FAILED',
        fields: {
          step: 'answerPrompt',
          code: reason,
          caseId: CASE,
          promptId: 'prompt-1',
        },
      });
    }
  );

  it('classifies with the UTC date and sends nothing once the file is ready', async () => {
    const f = fake({ ready: true });
    expect(await onCustomerGroupText(f.ports, textInput(' 2 '))).toBe('ready');
    expect(f.calls.find((c) => c.name === 'answerPrompt')!.args).toEqual({
      promptId: 'prompt-1',
      choice: 2,
      now: NOW,
    });
    expect(f.calls.find((c) => c.name === 'classifyAndCheck')!.args).toEqual({
      fileId: 'file-1',
      docKey: 'passport',
      today: '2026-11-10',
    });
    expect(f.sends()).toEqual([]);
  });

  it('sends the remaining list when passed but not ready', async () => {
    const f = fake({ passed: ['passport'] });
    expect(await onCustomerGroupText(f.ports, textInput('2'))).toBe('received');
    expect(f.sends()).toEqual([
      'Got Passport. Still needed:\n1. emirates id\n2. Salary certificate',
    ]);
  });

  it('sends nothing on a pass when received_next is not approved', async () => {
    const f = fake({ templates: { document_received_next: null } });
    expect(await onCustomerGroupText(f.ports, textInput('2'))).toBe('received');
    expect(f.sends()).toEqual([]);
  });

  it('sends the rejection with the failed check names', async () => {
    const f = fake({
      check: {
        status: 'failed',
        checks: [
          { name: 'mime', ok: true },
          { name: 'size', ok: false },
          { name: 'expiry', ok: false },
        ],
      },
    });
    expect(await onCustomerGroupText(f.ports, textInput('2'))).toBe('rejected');
    expect(f.sends()).toEqual(['Passport failed: size, expiry']);
    expect(f.names()).not.toContain('fileReady');
  });

  it('sends nothing on a failure when the rejection is not approved', async () => {
    const f = fake({
      templates: { document_rejected: null },
      check: { status: 'failed', checks: [{ name: 'size', ok: false }] },
    });
    expect(await onCustomerGroupText(f.ports, textInput('2'))).toBe('rejected');
    expect(f.sends()).toEqual([]);
  });
});
