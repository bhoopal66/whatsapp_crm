/**
 * The journey engine's `ConsentPort` on Supabase: the consent register
 * on `contacts` (076's opt-out, 086's marketing opt-in and do-not-contact)
 * and 086's once-per-contact opt-in welcome claim. Server-only: it takes
 * the service-role client.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConsentPort } from '../ports';
import { JourneyDbError, rpcScalar } from './store';

interface Stamps {
  opted_out_at: string | null;
  marketing_opt_in_at: string | null;
  do_not_contact_at: string | null;
}

export class SupabaseConsentPort implements ConsentPort {
  constructor(private readonly db: SupabaseClient) {}

  /** A contact that is not there reads as no stamps at all. */
  private async stamps(contactId: string): Promise<Partial<Stamps>> {
    const { data, error } = await this.db
      .from('contacts')
      .select('opted_out_at, marketing_opt_in_at, do_not_contact_at')
      .eq('id', contactId)
      .maybeSingle();
    if (error) throw new JourneyDbError('contacts', error);
    return (data as Stamps | null) ?? {};
  }

  /** An opt-in counts only while the contact has not opted out since. */
  async hasMarketingOptIn(contactId: string): Promise<boolean> {
    const s = await this.stamps(contactId);
    return s.marketing_opt_in_at != null && s.opted_out_at == null;
  }

  async isOptedOut(contactId: string): Promise<boolean> {
    return (await this.stamps(contactId)).opted_out_at != null;
  }

  async doNotContact(contactId: string): Promise<boolean> {
    return (await this.stamps(contactId)).do_not_contact_at != null;
  }

  /**
   * The step-time cap: true once the welcome is claimed, or once a
   * MARK_OPTIN_WELCOME_SENT for the contact is committed and not dropped
   * (086's journey_has_optin_welcome). The MARK item is emitted before
   * the SEND and counts from commit time, so a second event cannot plan
   * a second welcome while the first waits for delivery; the sink
   * delivers MARK as a no-op, leaving the claim to the SEND itself.
   */
  async hasReceivedOptinWelcome(contactId: string): Promise<boolean> {
    const { data, error } = await this.db.rpc('journey_has_optin_welcome', {
      p_contact_id: contactId,
    });
    if (error) throw new JourneyDbError('journey_has_optin_welcome', error);
    return rpcScalar('journey_has_optin_welcome', data) === true;
  }

  async claimOptinWelcome(
    contactId: string,
    claimId: string
  ): Promise<boolean> {
    const { data, error } = await this.db.rpc('journey_claim_optin_welcome', {
      p_contact_id: contactId,
      p_claim_id: claimId,
    });
    if (error) throw new JourneyDbError('journey_claim_optin_welcome', error);
    return rpcScalar('journey_claim_optin_welcome', data) === true;
  }
}
