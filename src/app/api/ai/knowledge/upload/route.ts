import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { loadEmbeddingsKey } from '@/lib/ai/config';
import { ingestDocument } from '@/lib/ai/knowledge';
import { AiError } from '@/lib/ai/types';
import {
  MAX_KNOWLEDGE_UPLOAD_BYTES,
  extractKnowledgeText,
  isSupportedKnowledgeFile,
  titleFromFilename,
} from '@/lib/ai/extract-text';

/**
 * POST /api/ai/knowledge/upload  (admin+)
 *
 * multipart/form-data with one `file` (PDF, or plain text / Markdown /
 * CSV / JSON) and an optional `title`. The file's text becomes one
 * knowledge-base document, indexed exactly as a pasted one — the
 * extraction step is the only difference from `POST /api/ai/knowledge`.
 * The bytes are not stored; the KB holds text, and the original stays
 * with whoever uploaded it.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 });
    }
    if (file.size > MAX_KNOWLEDGE_UPLOAD_BYTES) {
      return NextResponse.json(
        {
          error: `File is too large (max ${Math.round(MAX_KNOWLEDGE_UPLOAD_BYTES / 1024 / 1024)} MB).`,
        },
        { status: 413 }
      );
    }
    if (!isSupportedKnowledgeFile(file.name, file.type)) {
      return NextResponse.json(
        { error: 'Upload a PDF, .txt, .md, .csv or .json file.' },
        { status: 415 }
      );
    }

    const rawTitle = form?.get('title');
    const title =
      (typeof rawTitle === 'string' && rawTitle.trim()) ||
      titleFromFilename(file.name);

    const content = await extractKnowledgeText(
      file.name,
      file.type,
      await file.arrayBuffer()
    );

    const { data: doc, error } = await supabase
      .from('ai_knowledge_documents')
      .insert({ account_id: accountId, created_by: userId, title, content })
      .select('id')
      .single();
    if (error || !doc) {
      console.error('[ai/knowledge upload] insert error:', error);
      return NextResponse.json(
        { error: 'Failed to save document' },
        { status: 500 }
      );
    }

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
      supabase,
      accountId
    );
    try {
      await ingestDocument(
        supabase,
        accountId,
        { embeddingsApiKey },
        doc.id,
        content
      );
    } catch (err) {
      const message = err instanceof AiError ? err.message : 'indexing failed';
      console.error('[ai/knowledge upload] ingest error:', err);
      return NextResponse.json({
        success: true,
        id: doc.id,
        chars: content.length,
        warning: `Saved, but semantic indexing failed (${message}). Lexical search still works; use Reindex to retry.`,
      });
    }
    if (corrupt) {
      return NextResponse.json({
        success: true,
        id: doc.id,
        chars: content.length,
        warning:
          'Saved with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).',
      });
    }
    return NextResponse.json({
      success: true,
      id: doc.id,
      chars: content.length,
    });
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    return toErrorResponse(err);
  }
}
