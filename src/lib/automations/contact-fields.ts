/** The contact columns a "Contact field" condition compares, in menu
 *  order. The builder offers these and activation refuses any other. */
export const CONDITION_CONTACT_FIELDS = [
  'name',
  'phone',
  'email',
  'company',
] as const;

export function isConditionContactField(value: unknown): boolean {
  return (CONDITION_CONTACT_FIELDS as readonly unknown[]).includes(value);
}
