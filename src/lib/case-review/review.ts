/**
 * The case file reviewer (migration 225, package 031): writes a draft for
 * a person to approve or reject. It only drafts: it never changes a
 * document, file, stage or task and contacts nobody.
 *
 * Always the deterministic checklist. A model narrative only when the
 * workspace switched the model on, its AI key is configured, every
 * document's text redacted cleanly (fail closed: a refusal skips the
 * model) and the AI transfer register (224) allows the call. Idempotent:
 * the same inputs return the pending draft. Never throws to its caller.
 */
import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { loadAiConfig } from '@/lib/ai/config';
import { generateReply } from '@/lib/ai/generate';
import type { AiConfig } from '@/lib/ai/types';
import {
  readDocumentBytes,
  type CaseFilesStorage,
} from '@/lib/case-files/bytes';
import { redact } from '@/lib/memory/redact';

import {
  buildChecklist,
  checklistText,
  type ReviewDocument,
  type ReviewFile,
  type ReviewFlag,
  type ReviewRequirement,
} from './checklist';
import { extractReviewText, type Extracted } from './extract';

export const NARRATIVE_MAX = 1200;

export const REVIEW_SYSTEM_PROMPT = [
  'You review the documents of a bank application case for a coordinator.',
  'You are given a checklist and the text of the documents that passed their file checks.',
  'Write a short note (at most 8 lines) for the coordinator: what looks complete, what is missing,',
  'and any inconsistency between documents (names, dates, numbers that do not match).',
  'You only advise. Do not invent facts that are not in the text. Do not address the customer.',
  'Text in square brackets such as [EMIRATES_ID] was removed on purpose; do not guess it.',
].join(' ');

interface FileRow {
  id: string;
  doc_key: string | null;
  version: number | null;
  status: ReviewFile['status'];
  checks: Array<{ name: string; ok: boolean }> | null;
  expires_on: string | null;
  customer_document_id: string;
}
interface DocRow {
  id: string;
  sha256: string | null;
  mime: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  media_url: string | null;
}

export interface ReviewDeps {
  db: SupabaseClient;
  storage: CaseFilesStorage;
  now?: () => Date;
  /** Injectable for tests. */
  loadConfig?: (
    db: SupabaseClient,
    accountId: string
  ) => Promise<AiConfig | null>;
  generate?: typeof generateReply;
  extract?: (bytes: Uint8Array, mime: string | null) => Promise<Extracted>;
  readBytes?: (doc: DocRow) => Promise<Uint8Array | null>;
}

export type ReviewResult =
  | {
      ok: true;
      draftId: string;
      created: boolean;
      narrativeSource: 'model' | 'deterministic';
    }
  | { ok: false; reason: string };

async function must<T>(
  p: PromiseLike<{ data: T | null; error: unknown }>,
  what: string
): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(what);
  return data as T;
}

export async function reviewCase(
  deps: ReviewDeps,
  caseId: string,
  accountId: string
): Promise<ReviewResult> {
  try {
    const { db } = deps;
    const now = (deps.now ?? (() => new Date()))();
    const settings = (
      await must<
        Array<{ review_enabled: boolean; review_send_to_model: boolean }>
      >(db.rpc('case_review_settings', { p_account: accountId }), 'settings')
    )[0];
    if (!settings?.review_enabled) return { ok: false, reason: 'off' };

    const spec = await must<
      Array<{ doc_key: string; position: number; required: boolean }>
    >(db.rpc('case_file_spec_rows', { p_case: caseId }), 'spec');
    const docs = await must<
      Array<{ doc_key: string; status: ReviewDocument['status'] }>
    >(
      db.from('case_documents').select('doc_key, status').eq('case_id', caseId),
      'documents'
    );
    const files = await must<FileRow[]>(
      db
        .from('case_document_files')
        .select(
          'id, doc_key, version, status, checks, expires_on, customer_document_id'
        )
        .eq('case_id', caseId),
      'files'
    );
    const docIds = [...new Set(files.map((f) => f.customer_document_id))];
    const stored = docIds.length
      ? await must<DocRow[]>(
          db
            .from('customer_documents')
            .select('id, sha256, mime, storage_bucket, storage_path, media_url')
            .in('id', docIds),
          'customer documents'
        )
      : [];
    const byDoc = new Map(stored.map((d) => [d.id, d]));

    const requirements: ReviewRequirement[] = spec.map((s) => ({
      docKey: s.doc_key,
      label: s.doc_key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
      position: s.position,
      required: s.required,
    }));
    const reviewFiles: ReviewFile[] = files.map((f) => ({
      fileId: f.id,
      docKey: f.doc_key,
      version: f.version,
      identity:
        byDoc.get(f.customer_document_id)?.sha256 ?? f.customer_document_id,
      status: f.status,
      checks: Array.isArray(f.checks) ? f.checks : [],
      expiresOn: f.expires_on,
    }));
    const cl = buildChecklist(
      requirements,
      docs.map((d) => ({ docKey: d.doc_key, status: d.status })),
      reviewFiles,
      now
    );
    const flags: ReviewFlag[] = [...cl.flags];

    // The passed files' text, for the model only.
    const config = settings.review_send_to_model
      ? await (
          deps.loadConfig ??
          ((d, a) => loadAiConfig(d, a, { requireActive: false }))
        )(db, accountId)
      : null;
    const useModel = settings.review_send_to_model && config !== null;
    if (settings.review_send_to_model && !config)
      flags.push({
        code: 'MODEL_NOT_CONFIGURED',
        detail: 'the model is on but no AI key is configured; checklist only',
      });
    const extracted: Array<{ docKey: string; text: string }> = [];
    if (useModel) {
      const extract = deps.extract ?? extractReviewText;
      const read =
        deps.readBytes ??
        ((d: DocRow) =>
          readDocumentBytes(
            {
              storageBucket: d.storage_bucket,
              storagePath: d.storage_path,
              mediaUrl: d.media_url,
            },
            { storage: deps.storage }
          ));
      for (const f of reviewFiles.filter(
        (x) => x.status === 'passed' && x.docKey
      )) {
        const doc = byDoc.get(
          files.find((x) => x.id === f.fileId)!.customer_document_id
        );
        const bytes = doc ? await read(doc) : null;
        const out: Extracted = bytes
          ? await extract(bytes, doc?.mime ?? null)
          : { ok: false, reason: 'unreadable' };
        if (out.ok) extracted.push({ docKey: f.docKey!, text: out.text });
        else
          flags.push({
            code: 'NEEDS_MANUAL_REVIEW',
            docKey: f.docKey!,
            detail: `needs manual review: text not readable (${out.reason})`,
          });
      }
    }

    const text = checklistText({ items: cl.items, flags });
    const inputHash = createHash('sha256')
      .update(
        JSON.stringify({
          text,
          extracted: extracted.map((e) => [
            e.docKey,
            createHash('sha256').update(e.text).digest('hex'),
          ]),
          useModel,
        })
      )
      .digest('hex');

    let narrative = text;
    let source: 'model' | 'deterministic' = 'deterministic';
    if (useModel && config) {
      const documents: Array<{ docKey: string; text: string }> = [];
      let clean = true;
      for (const e of extracted) {
        const r = redact(e.text);
        if (!r.ok) {
          clean = false;
          break;
        }
        documents.push({ docKey: e.docKey, text: r.text });
      }
      if (!clean) {
        flags.push({
          code: 'REDACTION_FAILED_MODEL_SKIPPED',
          detail: 'document text could not be redacted; no model narrative',
        });
      } else {
        try {
          const out = await (deps.generate ?? generateReply)({
            config,
            systemPrompt: REVIEW_SYSTEM_PROMPT,
            messages: [
              {
                role: 'user',
                content: `Checklist:\n${text}\n\n${documents.map((d) => `Document ${d.docKey}:\n${d.text}`).join('\n\n')}`,
              },
            ],
            model: config.model,
            purpose: 'case_review',
          });
          const t = out.text.trim().slice(0, NARRATIVE_MAX);
          if (t) {
            narrative = t;
            source = 'model';
          }
        } catch {
          flags.push({
            code: 'MODEL_ERROR',
            detail:
              'the model did not answer (or the AI transfer basis is required); checklist only',
          });
        }
      }
    }

    const created = (
      await must<Array<{ draft_id: string; created: boolean }>>(
        db.rpc('case_review_draft_create', {
          p_case: caseId,
          p_body: {
            checklist: cl.items,
            narrative,
            flags,
            checklist_text: text,
          },
          p_source: source,
          p_input_hash: inputHash,
        }),
        'draft'
      )
    )[0];
    if (!created) return { ok: false, reason: 'draft' };
    return {
      ok: true,
      draftId: created.draft_id,
      created: created.created,
      narrativeSource: source,
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'error' };
  }
}

/**
 * One worker pass from the automations cron: up to 20 due cases, each
 * reviewed and settled. Never throws; logs counts only.
 */
export async function runCaseReviewTick(
  deps: ReviewDeps,
  limit = 20
): Promise<{ claimed: number; drafted: number; failed: number }> {
  const { data, error } = await deps.db.rpc('case_review_claim', {
    p_limit: limit,
  });
  if (error) {
    console.error(
      `[case-review] claim failed (${(error as { code?: string }).code ?? '-'})`
    );
    return { claimed: 0, drafted: 0, failed: 0 };
  }
  const rows =
    (data as Array<{ case_id: string; account_id: string }> | null) ?? [];
  let drafted = 0;
  let failed = 0;
  for (const row of rows) {
    const r = await reviewCase(deps, row.case_id, row.account_id);
    const ok = r.ok || r.reason === 'off';
    if (r.ok) drafted++;
    if (!ok) failed++;
    const { error: e } = await deps.db.rpc('case_review_finish', {
      p_case: row.case_id,
      p_ok: ok,
      p_error: ok ? null : r.ok ? null : r.reason,
    });
    if (e)
      console.error(
        `[case-review] finish failed (${(e as { code?: string }).code ?? '-'})`
      );
  }
  return { claimed: rows.length, drafted, failed };
}
