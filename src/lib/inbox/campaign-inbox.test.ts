import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_INBOX_FILTER,
  INBOX_FILTER,
  inCampaignInbox,
  type CampaignInboxFields,
} from './campaign-inbox';

const CAMPAIGN = 'b0000000-0000-4000-8000-000000000001';
const AGENT = 'a0000000-0000-4000-8000-000000000001';
const STAMP = '2026-10-01T08:30:00Z';

/** A chat the bot is answering; each test changes one thing. */
const BOT_CHAT: CampaignInboxFields = {
  campaign_broadcast_id: CAMPAIGN,
  human_engaged_at: null,
  assigned_agent_id: undefined,
  ai_autoreply_disabled: false,
  ai_reply_count: 2,
};

describe('inCampaignInbox', () => {
  it('holds a campaign chat the bot is answering', () => {
    expect(inCampaignInbox(BOT_CHAT, true)).toBe(true);
  });

  it('holds nothing while the AI auto-reply is off', () => {
    expect(inCampaignInbox(BOT_CHAT, false)).toBe(false);
  });

  it('leaves a chat that never came from a campaign to the Inbox', () => {
    expect(
      inCampaignInbox({ ...BOT_CHAT, campaign_broadcast_id: null }, true)
    ).toBe(false);
  });

  it('leaves a campaign reply the AI has not answered to the Inbox', () => {
    expect(inCampaignInbox({ ...BOT_CHAT, ai_reply_count: 0 }, true)).toBe(
      false
    );
    expect(
      inCampaignInbox({ ...BOT_CHAT, ai_reply_count: undefined }, true)
    ).toBe(false);
  });

  it('moves a chat the bot handed off, or was paused on, to the Inbox', () => {
    expect(
      inCampaignInbox({ ...BOT_CHAT, ai_autoreply_disabled: true }, true)
    ).toBe(false);
  });

  it('moves a chat a person stepped into to the Inbox for good', () => {
    // The stamp outlives the assignment that set it.
    expect(
      inCampaignInbox({ ...BOT_CHAT, human_engaged_at: STAMP }, true)
    ).toBe(false);
  });

  it('moves a chat assigned on this screen before realtime brings the stamp', () => {
    expect(
      inCampaignInbox({ ...BOT_CHAT, assigned_agent_id: AGENT }, true)
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------
// The query filters must say exactly what the predicate says. A tiny
// evaluator for the PostgREST conditions they use, run over every
// combination of the columns involved.
// ---------------------------------------------------------------------

type Row = Record<string, string | number | boolean | null>;

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function evalCondition(cond: string, row: Row): boolean {
  const dot = cond.indexOf('.');
  const value = row[cond.slice(0, dot)];
  const op = cond.slice(dot + 1);
  if (op === 'is.null') return value === null;
  if (op === 'not.is.null') return value !== null;
  if (op === 'is.true') return value === true;
  if (op === 'is.false') return value === false;
  const m = /^(gt|lte)\.(-?\d+)$/.exec(op);
  if (!m) throw new Error(`unsupported condition: ${cond}`);
  const n = Number(m[2]);
  return m[1] === 'gt' ? (value as number) > n : (value as number) <= n;
}

/** An `or` group: terms that are conditions or `and(...)` of them. */
function evalOrGroup(group: string, row: Row): boolean {
  return splitTopLevel(group).some((term) => {
    const and = /^and\((.*)\)$/.exec(term);
    return and
      ? splitTopLevel(and[1]).every((c) => evalCondition(c, row))
      : evalCondition(term, row);
  });
}

function everyRow(): Row[] {
  const rows: Row[] = [];
  for (const campaign_broadcast_id of [null, CAMPAIGN])
    for (const human_engaged_at of [null, STAMP])
      for (const assigned_agent_id of [null, AGENT])
        for (const ai_autoreply_disabled of [false, true])
          for (const ai_reply_count of [0, 1, 3])
            rows.push({
              campaign_broadcast_id,
              human_engaged_at,
              assigned_agent_id,
              ai_autoreply_disabled,
              ai_reply_count,
            });
  return rows;
}

describe('the list filters', () => {
  const rows = everyRow();

  it('Campaign inbox filter matches the predicate on every row', () => {
    for (const row of rows) {
      expect(evalOrGroup(CAMPAIGN_INBOX_FILTER, row), JSON.stringify(row)).toBe(
        inCampaignInbox(row as CampaignInboxFields, true)
      );
    }
  });

  it('Inbox filter is its exact complement', () => {
    for (const row of rows) {
      expect(evalOrGroup(INBOX_FILTER, row), JSON.stringify(row)).toBe(
        !inCampaignInbox(row as CampaignInboxFields, true)
      );
    }
  });

  it('puts every chat in exactly one list', () => {
    for (const row of rows) {
      expect(
        evalOrGroup(CAMPAIGN_INBOX_FILTER, row) !==
          evalOrGroup(INBOX_FILTER, row)
      ).toBe(true);
    }
  });
});
