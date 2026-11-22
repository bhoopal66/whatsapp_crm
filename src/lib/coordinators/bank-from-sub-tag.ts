// "Share with bank": the bank a chat's sub-tag names, if any. A chat
// tagged e.g. "Interested" with the sub-tag "ADCB" (migration 075's
// `chat_sub_tag_id`, often captioned "Bank: …") is about that bank, so
// the share dialog opens with it selected. Pure; a near miss selects
// nothing, so the agent never shares under a bank they did not pick.

export interface BankChoice {
  code: string;
  name: string;
}

function norm(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase();
}

/**
 * The code of the one bank in `banks` whose code or name equals the
 * sub-tag's name (trimmed, case-insensitive), else null. A code match
 * wins over a name match; a name shared by two banks chooses nothing.
 */
export function bankFromSubTag(
  subTagName: string | null | undefined,
  banks: readonly BankChoice[]
): string | null {
  const wanted = norm(subTagName);
  if (!wanted) return null;
  const byCode = banks.filter((b) => norm(b.code) === wanted);
  if (byCode.length === 1) return byCode[0].code;
  if (byCode.length > 1) return null;
  const byName = banks.filter((b) => norm(b.name) === wanted);
  return byName.length === 1 ? byName[0].code : null;
}
