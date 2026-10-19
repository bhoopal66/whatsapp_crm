import { CasePage } from '@/components/cases/case-page/case-page';

/** /cases/[id] — one case: header, actions, overview and its tabs. */
export default async function CaseRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CasePage key={id} caseId={id} />;
}
