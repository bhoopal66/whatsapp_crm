/**
 * 024a escalation specialist: never calls a model and never promises anything. It drafts a fixed holding line so a
 * recruiter can approve an acknowledgement while the sensitive topic (salary, offer, visa, contract, legal, upset)
 * is handled personally.
 */
import type { SpecialistInput, SpecialistResult } from './common';

const HOLDING = {
  en: 'Thank you for your message. A recruiter will review it and reply to you personally.',
  ar: '\u0634\u0643\u0631\u0627 \u0644\u0631\u0633\u0627\u0644\u062A\u0643. \u0633\u064A\u0631\u0627\u062C\u0639\u0647\u0627 \u0623\u062D\u062F \u0645\u0633\u0624\u0648\u0644\u064A \u0627\u0644\u062A\u0648\u0638\u064A\u0641 \u0648\u064A\u0631\u062F \u0639\u0644\u064A\u0643 \u0634\u062E\u0635\u064A\u0627.',
} as const;

export async function escalation(
  input: SpecialistInput
): Promise<SpecialistResult> {
  return { text: HOLDING[input.lang] };
}
