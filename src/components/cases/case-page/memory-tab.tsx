'use client';

import { MemoryPanel } from '@/components/memory/memory-panel';
import { useAuth } from '@/hooks/use-auth';
import { hasMinRole } from '@/lib/auth/roles';
import type { CaseTabProps } from '@/lib/cases/case-page';

/**
 * The case's Memory tab (019b): what was agreed on this case. Forget
 * all is the workspace owner's / admin's, as the forget route rules.
 */
export function MemoryTab({ caseId, detail }: CaseTabProps) {
  const { accountRole } = useAuth();
  return (
    <MemoryPanel
      apiBase={`/api/cases/${caseId}/memory`}
      canWrite={detail.permissions.canWrite}
      canForget={!!accountRole && hasMinRole(accountRole, 'admin')}
    />
  );
}
