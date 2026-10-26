import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  STAGE_CHIP,
  STAGE_CHIP_OTHER,
  stageChipClass,
  activeFilterCount,
  appendRows,
  DEFAULT_STAGES,
  EMPTY_FILTERS,
  filtersFromSearch,
  filtersToSearch,
  formatAed,
  stageFilterOptions,
  inboxUrl,
  isPresubStage,
  parseBanks,
  parseDays,
  parseInboxPage,
  PRESUB_STAGES,
  type InboxFilters,
} from './ui';

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/130_case_leads.sql'),
  'utf8'
);

describe('DEFAULT_STAGES', () => {
  it("equals 130's case_default_stages(), in order", () => {
    const fn =
      /FUNCTION public\.case_default_stages\(\)[\s\S]*?ARRAY\[([\s\S]*?)\]::text\[\]/.exec(
        SQL
      );
    expect(fn, 'case_default_stages() not found in 130').not.toBeNull();
    const stages = [...fn![1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect(stages.length).toBeGreaterThan(0);
    expect(DEFAULT_STAGES).toEqual(stages);
  });

  it("starts with 130's case_presub_stages(), which isPresubStage matches", () => {
    const fn =
      /FUNCTION public\.case_presub_stages\(\)[\s\S]*?ARRAY\[([\s\S]*?)\]::text\[\]/.exec(
        SQL
      );
    expect(fn, 'case_presub_stages() not found in 130').not.toBeNull();
    const presub = [...fn![1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect(PRESUB_STAGES).toEqual(presub);
    expect(DEFAULT_STAGES.slice(0, presub.length)).toEqual(presub);
    expect(DEFAULT_STAGES.filter(isPresubStage)).toEqual(presub);
    expect(isPresubStage('Submitted')).toBe(false);
    expect(isPresubStage(null)).toBe(false);
  });
});

const search = (q: string) => {
  const p = new URLSearchParams(q);
  return (k: string) => p.get(k);
};

const ALL: InboxFilters = {
  bank: 'ADCB',
  stage: 'Under review',
  agent: 'u1',
  priority: 'urgent',
  slaState: 'overdue',
  customerWaiting: true,
  documentsMissing: true,
  bankQueryOpen: true,
  includeClosed: true,
  noActivityDays: 5,
  sort: 'stalest',
};

describe('filters <-> URL', () => {
  it('reads nothing as the defaults and writes the defaults as nothing', () => {
    expect(filtersFromSearch(search(''))).toEqual(EMPTY_FILTERS);
    expect(filtersToSearch(EMPTY_FILTERS)).toBe('');
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
  });

  it('round-trips every filter', () => {
    const qs = filtersToSearch(ALL);
    expect(qs).toBe(
      'bank=ADCB&stage=Under+review&agent=u1&priority=urgent&sla_state=overdue' +
        '&customer_waiting=true&documents_missing=true&bank_query_open=true' +
        '&include_closed=true&no_activity_days=5&sort=stalest'
    );
    expect(filtersFromSearch(search(qs))).toEqual(ALL);
    // The sort orders, it does not narrow.
    expect(activeFilterCount(ALL)).toBe(10);
  });

  it('drops unknown values instead of sending them', () => {
    expect(
      filtersFromSearch(
        search(
          'priority=asap&sla_state=late&sort=random&customer_waiting=yes' +
            '&no_activity_days=0&bank=%20%20'
        )
      )
    ).toEqual(EMPTY_FILTERS);
  });

  it('accepts 1..3650 whole days only', () => {
    expect(parseDays('1')).toBe(1);
    expect(parseDays(' 3650 ')).toBe(3650);
    expect(parseDays('3651')).toBeNull();
    expect(parseDays('0')).toBeNull();
    expect(parseDays('2.5')).toBeNull();
    expect(parseDays('-3')).toBeNull();
    expect(parseDays(null)).toBeNull();
  });
});

describe('inboxUrl', () => {
  it('sends only chosen filters, the page size and the cursor', () => {
    expect(inboxUrl(EMPTY_FILTERS, null)).toBe('/api/cases?limit=50');
    expect(
      inboxUrl({ ...EMPTY_FILTERS, customerWaiting: true }, 'cur 1', 20)
    ).toBe('/api/cases?customer_waiting=true&limit=20&after=cur+1');
  });
});

const row = {
  caseId: 'c1',
  bankCode: 'ADCB',
  bankName: 'ADCB',
  stage: 'Submitted',
  agentId: 'u1',
  coordinatorId: null,
  priority: 'high',
  dueAt: '2026-10-20T08:00:00.000Z',
  slaState: 'due_soon',
  overdueRank: [0, 1],
  customerWaiting: true,
  documentsMissing: 2,
  bankQueryOpen: false,
  lastActivityAt: '2026-10-19T08:00:00.000Z',
  lastTouchedBy: 'u2',
  openTaskOverdueCount: 1,
  submissionRef: 'SUB-1',
  isLead: false,
  contactId: 'k1',
  contactName: 'Sara',
  product: 'Home loan',
  amount: 1250000.5,
  openedAt: '2026-10-01T00:00:00.000Z',
  closedAt: null,
  cursor: 'x',
};

describe('parseInboxPage', () => {
  it('reads rows and the cursor', () => {
    const page = parseInboxPage({ rows: [row], nextCursor: 'n1' });
    expect(page.nextCursor).toBe('n1');
    expect(page.rows).toEqual([
      {
        caseId: 'c1',
        bankCode: 'ADCB',
        bankName: 'ADCB',
        stage: 'Submitted',
        agentId: 'u1',
        coordinatorId: null,
        priority: 'high',
        dueAt: '2026-10-20T08:00:00.000Z',
        slaState: 'due_soon',
        customerWaiting: true,
        documentsMissing: 2,
        bankQueryOpen: false,
        lastActivityAt: '2026-10-19T08:00:00.000Z',
        lastTouchedBy: 'u2',
        openTaskOverdueCount: 1,
        submissionRef: 'SUB-1',
        isLead: false,
        contactId: 'k1',
        contactName: 'Sara',
        product: 'Home loan',
        amount: 1250000.5,
        openedAt: '2026-10-01T00:00:00.000Z',
        closedAt: null,
      },
    ]);
  });

  it('survives a malformed body and malformed fields', () => {
    expect(parseInboxPage(null)).toEqual({ rows: [], nextCursor: null });
    expect(parseInboxPage({ rows: 'x', nextCursor: '' })).toEqual({
      rows: [],
      nextCursor: null,
    });
    const [r] = parseInboxPage({
      rows: [
        {
          caseId: 'c2',
          priority: 'asap',
          slaState: 'late',
          amount: '12.5',
          documentsMissing: -1,
        },
        { nope: 1 },
        null,
      ],
    }).rows;
    expect(r).toMatchObject({
      caseId: 'c2',
      stage: '',
      priority: 'normal',
      slaState: null,
      amount: 12.5,
      documentsMissing: 0,
      customerWaiting: false,
    });
  });

  it('reads isLead only when it is literally true', () => {
    const rows = parseInboxPage({
      rows: [
        { ...row, caseId: 'l1', isLead: true, submissionRef: null },
        { ...row, caseId: 'l2', isLead: 'true' },
        { ...row, caseId: 'l3', isLead: undefined },
      ],
    }).rows;
    expect(rows.map((r) => [r.caseId, r.isLead])).toEqual([
      ['l1', true],
      ['l2', false],
      ['l3', false],
    ]);
  });

  it('keeps one row per case across pages', () => {
    const a = parseInboxPage({ rows: [row] }).rows;
    const b = parseInboxPage({ rows: [row, { ...row, caseId: 'c9' }] }).rows;
    expect(appendRows(a, b).map((r) => r.caseId)).toEqual(['c1', 'c9']);
  });
});

describe('parseBanks / formatAed', () => {
  it('reads the bank list and falls back to empty', () => {
    expect(
      parseBanks({
        banks: [
          { code: 'ADCB', name: 'ADCB', hasOwnStages: false },
          { code: 'FAB' },
          { name: 'no code' },
        ],
      })
    ).toEqual([
      { code: 'ADCB', name: 'ADCB' },
      { code: 'FAB', name: 'FAB' },
    ]);
    expect(parseBanks({ error: 'Forbidden' })).toEqual([]);
    expect(parseBanks(null)).toEqual([]);
  });

  it('formats AED with 2 decimals', () => {
    // Intl separates the code with a no-break space.
    const plain = (s: string | null) => s?.replace(/\s/g, ' ');
    expect(plain(formatAed(1250000.5, 'en'))).toBe('AED 1,250,000.50');
    expect(plain(formatAed(0, 'en'))).toBe('AED 0.00');
    expect(formatAed(null, 'en')).toBeNull();
  });

  it('keeps every digit of a decimal string', () => {
    const plain = (s: string | null) => s?.replace(/\s/g, ' ');
    expect(plain(formatAed('12345678901234567.89', 'en'))).toBe(
      'AED 12,345,678,901,234,567.89'
    );
    expect(plain(formatAed('1200.5', 'en'))).toBe('AED 1,200.50');
    expect(formatAed('abc', 'en')).toBeNull();
  });
});

describe('stageFilterOptions', () => {
  it('lists defaults first, then sorted extras from rows and the selection', () => {
    const rows = [
      { stage: 'Zeta' },
      { stage: DEFAULT_STAGES[0] },
      { stage: 'Alpha' },
      { stage: 'Zeta' },
    ];
    expect(stageFilterOptions(rows, 'Mid')).toEqual([
      ...DEFAULT_STAGES,
      'Alpha',
      'Mid',
      'Zeta',
    ]);
    expect(stageFilterOptions([], null)).toEqual([...DEFAULT_STAGES]);
  });
});

describe('stage chip colours', () => {
  it('colours every default stage, and an unknown one neutrally', () => {
    for (const stage of DEFAULT_STAGES)
      expect(stageChipClass(stage), stage).not.toBe(STAGE_CHIP_OTHER);
    expect(stageChipClass('Sent to credit')).toBe(STAGE_CHIP_OTHER);
    expect(stageChipClass(null)).toBe(STAGE_CHIP_OTHER);
    expect(stageChipClass('constructor')).toBe(STAGE_CHIP_OTHER);
  });

  it('tells the outcomes and the waiting stages apart', () => {
    const outcomes = ['Approved', 'Declined', 'Documents requested'].map(
      stageChipClass
    );
    expect(new Set(outcomes).size).toBe(3);
    expect(stageChipClass('Approved')).toContain('text-success');
    expect(stageChipClass('Declined')).toContain('text-destructive');
  });

  it('pairs every raw hue with a dark-mode shade', () => {
    for (const [stage, cls] of Object.entries(STAGE_CHIP)) {
      const raw = cls.match(/(?<!:)\btext-[a-z]+-\d{3}\b/g) ?? [];
      for (const r of raw)
        expect(cls, `${stage}: ${r}`).toMatch(/\bdark:text-[a-z]+-\d{3}\b/);
      // a light-mode text shade must be dark enough to read on white
      for (const r of raw)
        expect(
          Number(r.split('-').pop()),
          `${stage}: ${r}`
        ).toBeGreaterThanOrEqual(700);
    }
  });
});
