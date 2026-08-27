import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { listFlowTemplates } from '@/lib/flows/templates'

/**
 * GET /api/flows/templates
 *
 * Returns the static template gallery (slug + name + description +
 * icon hint + node_count) so the New-flow dialog can render cards
 * without bundling the full template payloads client-side. Bodies
 * are fetched only on actual clone via POST /api/flows.
 *
 * Admin+, matching the rest of /api/flows. The payload is the static
 * built-in gallery and carries no account data, so this is about
 * consistency rather than secrecy: its only caller is the New-flow
 * dialog, which now lives behind an admin-only screen.
 */
export async function GET() {
  try {
    await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  // Shallow shape so the client gallery doesn't have to know about
  // the full node tree.
  const templates = listFlowTemplates().map((t) => ({
    slug: t.slug,
    name: t.name,
    description: t.description,
    icon: t.icon,
    trigger_type: t.trigger_type,
    node_count: t.nodes.length,
  }))
  return NextResponse.json({ templates })
}
