/**
 * The name field's value after the profile object changed.
 *
 * `profile` is a new object whenever the profile watch picks up anything
 * (a role or department change), so seeding the field on every new object
 * wiped a name being typed. The field takes the stored name only on the
 * first load, or when the stored name really changed and the field is
 * still what was last seeded (untouched).
 *
 * @param current what the field holds now
 * @param seeded the stored name last put in the field; null before the first load
 * @param stored the stored name now
 */
export function seedFullName(
  current: string,
  seeded: string | null,
  stored: string
): string {
  if (seeded === null) return stored;
  if (stored === seeded) return current;
  return current === seeded ? stored : current;
}
