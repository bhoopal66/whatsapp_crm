// ============================================================
// GET /api/v1/case-documents?bank=FAB&product=Personal%20loan — the
// documents a bank requires for a product (scope:
// submission_groups:read). Taamul Compass validates its document map
// against it. The product matches case-insensitively on trimmed text,
// as the cases do (migration 123).
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';

const PRODUCT_MAX = 200;

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'submission_groups:read');
    const params = new URL(request.url).searchParams;
    const bank = (params.get('bank') ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9_]{2,32}$/.test(bank))
      return fail(
        'bad_request',
        "'bank' is required: 2-32 letters, digits or underscores",
        400
      );
    const product = (params.get('product') ?? '').trim();
    if (product.length < 1 || product.length > PRODUCT_MAX)
      return fail(
        'bad_request',
        `'product' is required: 1-${PRODUCT_MAX} characters`,
        400
      );
    // The match is on lower(btrim(product)); the stored side is compared in
    // the same shape, so fetch the bank's rows and compare here.
    const { data, error } = await ctx.supabase
      .from('case_doc_requirements')
      .select('doc_key, label, position, product')
      .eq('account_id', ctx.accountId)
      .eq('bank_code', bank)
      .order('position', { ascending: true });
    if (error) {
      console.error('[api/v1/case-documents]', error);
      return fail('internal', 'Failed to read the documents', 500);
    }
    const wanted = product.toLowerCase();
    const items = (data ?? [])
      .filter((r) => String(r.product).trim().toLowerCase() === wanted)
      .map((r) => ({ key: r.doc_key, label: r.label, position: r.position }));
    return ok({ bank, product, items });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
