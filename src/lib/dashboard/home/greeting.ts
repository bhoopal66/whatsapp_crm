/** The part of the day the dashboard greets, by the viewer's local hour. */
export type GreetingKey = 'morning' | 'afternoon' | 'evening';

export function greetingKey(hour: number): GreetingKey {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  return 'evening';
}

/**
 * What to call the person: the first word of their name, else their
 * email's local part, else nothing (the greeting then goes without).
 */
export function firstName(
  fullName: string | null | undefined,
  email: string | null | undefined
): string | null {
  const name = fullName?.trim().split(/\s+/)[0];
  if (name) return name;
  const local = email?.split('@')[0]?.trim();
  return local || null;
}
