import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/hr/agents/api', () => ({
  decideDraft: vi.fn(),
  listDrafts: vi.fn(),
  runAgents: vi.fn(),
}));

import type { HrAgentDraftRow } from '@/lib/hr/agents/api';

import {
  HrAgentDraftList,
  type DraftsT,
  type HrAgentDraftListProps,
} from './hr-agent-drafts';

const en = JSON.parse(
  readFileSync(join(process.cwd(), 'messages/en.json'), 'utf8')
) as { Hr: Record<string, unknown> };

/** The `Hr` catalogue with `{name}` placeholders filled, like next-intl. */
const t: DraftsT = (key, values) => {
  let node: unknown = en.Hr;
  for (const part of key.split('.')) {
    node = (node as Record<string, unknown> | undefined)?.[part];
  }
  if (typeof node !== 'string') throw new Error(`missing Hr.${key}`);
  return node.replace(/\{(\w+)\}/g, (_, k: string) => values?.[k] ?? '');
};

function draft(over: Partial<HrAgentDraftRow> = {}): HrAgentDraftRow {
  return {
    id: 'd1',
    account_id: 'a1',
    conversation_id: 'c1',
    source_message_id: null,
    agent_kind: 'candidate_faq',
    intent: 'question_process',
    body: 'Thank you for your question.',
    lang: 'en',
    requires_template: false,
    handoff_reason: null,
    status: 'pending',
    decided_by: null,
    decided_at: null,
    reject_reason: null,
    trace: null,
    created_by: null,
    created_at: new Date().toISOString(),
    ...over,
  } as HrAgentDraftRow;
}

function props(over: Partial<HrAgentDraftListProps> = {}) {
  return {
    t,
    drafts: [draft()],
    canAct: true,
    busy: false,
    reasons: {},
    onReasonChange: vi.fn(),
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onDismiss: vi.fn(),
    onCopy: vi.fn(),
    ...over,
  } satisfies HrAgentDraftListProps;
}

const html = (p: HrAgentDraftListProps) =>
  renderToStaticMarkup(<HrAgentDraftList {...p} />);

/** Every element in a tree, without rendering child components. */
function elements(node: ReactNode): Array<{ props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const p = node.props as Record<string, unknown>;
  return [{ props: p }, ...elements(p.children as ReactNode)];
}

describe('HrAgentDraftList', () => {
  it('shows a pending draft as kind - intent, Pending, Approve, reason, Reject', () => {
    const out = html(props());
    expect(out).toContain('Candidate questions');
    expect(out).toContain(' - Question about the process');
    expect(out).toContain('>Pending<');
    expect(out).toContain('Thank you for your question.');
    expect(out).toContain('data-action="agent-approve"');
    expect(out).toContain('Reason (optional)');
    expect(out).toContain('data-action="agent-reject"');
    expect(out.indexOf('agent-approve')).toBeLessThan(
      out.indexOf('Reason (optional)')
    );
    expect(out.indexOf('Reason (optional)')).toBeLessThan(
      out.indexOf('agent-reject')
    );
  });

  it('offers no action on a pending draft to someone who may not act', () => {
    const out = html(props({ canAct: false }));
    expect(out).toContain('>Pending<');
    expect(out).not.toContain('data-action');
    expect(out).not.toContain('Reason (optional)');
  });

  it('tells an approved draft to be sent from this chat, with Copy', () => {
    const out = html(props({ drafts: [draft({ status: 'approved' })] }));
    expect(out).toContain('>Approved<');
    expect(out).toContain('Approved — send it from this chat');
    expect(out).toContain('>Copy<');
    expect(out).not.toContain('data-action');
  });

  it('shows a rejected draft with its reason', () => {
    const out = html(
      props({
        drafts: [draft({ status: 'rejected', reject_reason: 'Too formal' })],
      })
    );
    expect(out).toContain('>Rejected<');
    expect(out).toContain('Reason: Too formal');
    expect(out).not.toContain('data-action');
  });

  it('says so when there are no drafts', () => {
    expect(html(props({ drafts: [] }))).toContain('No drafts yet.');
  });

  it('keeps the hand-off and template lines', () => {
    const out = html(
      props({
        drafts: [draft({ handoff_reason: 'keyword', requires_template: true })],
      })
    );
    expect(out).toContain('Handed to a person: a keyword in the message');
    expect(out).toContain('Needs an approved template');
    // A draft that needs a template cannot be approved, only rejected.
    expect(out).not.toContain('agent-approve');
    expect(out).toContain('agent-reject');
  });

  it('passes the typed reason to the reject decision', () => {
    const d = draft();
    const p = props({ drafts: [d], reasons: { d1: 'Not a fit' } });
    const tree = elements(HrAgentDraftList(p));

    const input = tree.find((e) => e.props.id === 'reject-reason-d1');
    (input?.props.onChange as (e: unknown) => void)({
      target: { value: 'Not a fit' },
    });
    expect(p.onReasonChange).toHaveBeenCalledWith('d1', 'Not a fit');
    expect(input?.props.value).toBe('Not a fit');

    const reject = tree.find((e) => e.props['data-action'] === 'agent-reject');
    (reject?.props.onClick as () => void)();
    expect(p.onReject).toHaveBeenCalledWith(d, 'Not a fit');
  });
});
