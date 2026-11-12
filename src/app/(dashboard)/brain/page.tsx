import { BrainSearch } from '@/components/brain/brain-search';
import { parseCaseScope } from '@/lib/brain/ui';

/** /brain — search the second brain, optionally one case (`?case=<uuid>`). */
export default async function BrainPage({
  searchParams,
}: {
  searchParams: Promise<{ case?: string | string[] }>;
}) {
  const { case: scope } = await searchParams;
  const caseId = parseCaseScope(Array.isArray(scope) ? scope[0] : scope);
  return <BrainSearch key={caseId ?? 'all'} caseId={caseId} />;
}
