/**
 * What picking a person in the chat header's assignee menu would do,
 * so the header can ask before it does it. `null` means nothing would
 * change (the person already holds the chat): no question, no write.
 */
export type AssignChangeKind = 'assign' | 'reassign' | 'unassign';

export function assignChangeKind(
  currentAgentId: string | null,
  nextAgentId: string | null
): AssignChangeKind | null {
  if (currentAgentId === nextAgentId) return null;
  if (nextAgentId === null) return 'unassign';
  return currentAgentId === null ? 'assign' : 'reassign';
}
