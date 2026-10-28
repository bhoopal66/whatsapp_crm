import { describe, expect, it, vi } from 'vitest';

import {
  parseTeamActivityReport,
  type NumberActivity,
  type SenderActivity,
  type TeamActivityReport,
} from '@/lib/team-activity/report';

import { loadTeamToday, teamFindings } from './team';

function sender(over: Partial<SenderActivity> = {}): SenderActivity {
  const base = parseTeamActivityReport({
    senders: [{ kind: 'person', user_id: 'u1', name: 'Sara' }],
  }).senders[0];
  return { ...base, ...over };
}

function number(over: Partial<NumberActivity> = {}): NumberActivity {
  const base = parseTeamActivityReport({
    numbers: [{ channel_id: 'w1', provider: 'whapi', status: 'connected' }],
  }).numbers[0];
  return { ...base, ...over };
}

function report(over: Partial<TeamActivityReport> = {}): TeamActivityReport {
  return {
    ...parseTeamActivityReport({ generated_at: '2026-10-28T09:00:00Z' }),
    senders: [
      sender({ userId: 'u1', name: 'Sara', nightStarts: 3 }),
      sender({ userId: 'u2', name: 'Ali', todayStarts: 25 }),
      sender({ userId: 'u3', name: 'Quiet' }),
      sender({ kind: 'api', userId: null, chaseNew: 3 }),
    ],
    numbers: [number({ label: 'Sales', numberTodayStarted: 50 })],
    waitingUnassignedRecent: 3,
    ...over,
  };
}

const rank = (level: string) => (level === 'act_now' ? 0 : 1);

describe('teamFindings', () => {
  it('lists at most three, act now first', () => {
    const items = teamFindings(report(), 'owner');
    expect(items).toHaveLength(3);
    const ranks = items.map((i) => rank(i.finding.level));
    expect(ranks).toEqual([...ranks].sort());
    expect(ranks[0]).toBe(0);
  });

  it('names the person or number a finding is about', () => {
    const items = teamFindings(report(), 'owner', 10);
    const ali = items.find((i) => i.finding.code === 'over_limit_today');
    expect(ali?.sender?.name).toBe('Ali');
    const num = items.find((i) => i.finding.subject.type === 'number');
    expect(num?.numberName).toBe('Sales');
    expect(num?.sender).toBeNull();
  });

  it('keeps the owner findings from a team leader', () => {
    const owner = teamFindings(report(), 'owner', 10);
    const leader = teamFindings(report(), 'leader', 10);
    expect(owner.some((i) => i.finding.audience === 'owner')).toBe(true);
    expect(leader.every((i) => i.finding.audience === 'leader')).toBe(true);
  });

  it('is empty on a quiet day', () => {
    expect(
      teamFindings(
        report({ senders: [], numbers: [], waitingUnassignedRecent: 0 }),
        'owner'
      )
    ).toEqual([]);
  });
});

describe('loadTeamToday', () => {
  const answer = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it("asks for today in the viewer's zone", async () => {
    const fetchImpl = answer(200, { report: report() });
    const out = await loadTeamToday('owner', fetchImpl, 'Asia/Dubai');
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/team-activity?range=today&tz=Asia%2FDubai',
      { cache: 'no-store' }
    );
    expect(out.status).toBe('ok');
    if (out.status === 'ok') {
      expect(out.glance.waitingUnassignedRecent).toBe(3);
      expect(out.findings.length).toBeGreaterThan(0);
    }
  });

  it('reads a 503 as the migration not applied', async () => {
    await expect(
      loadTeamToday('leader', answer(503, { error: 'x' }), 'UTC')
    ).resolves.toEqual({ status: 'not_migrated' });
  });

  it('throws on any other failure, so the panel offers Retry', async () => {
    await expect(
      loadTeamToday('leader', answer(500, { error: 'x' }), 'UTC')
    ).rejects.toThrow();
    await expect(
      loadTeamToday('leader', answer(200, {}), 'UTC')
    ).rejects.toThrow();
  });
});
