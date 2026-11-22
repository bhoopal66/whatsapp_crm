-- ============================================================
-- 253_merge_followups.sql — loose ends of the 2026-11-22 release
-- (migrations 236-252, built as four parallel tracks).
--
--  1. push_bell_url: a phone push for a notes @mention (241,
--     chat_note_mention) or a response-time bell (237,
--     response_target_missed / response_escalated / response_unassigned)
--     opens the chat, as the in-app bell already does (hrefFor in
--     src/lib/notifications/target.ts). Before this they fell back to
--     /notifications. RESTATES 205's body with those four types added:
--     apply in order, once (re-running 205 or earlier drops them).
--  2. PDPL: the lead source 249 added to contacts joins 221's export and
--     222's erase through 229's privacy_extensions registry. Export gives
--     lead_source and lead_source_detail; erase empties lead_source_detail
--     (ad referral data) and keeps lead_source (a category, not personal).
--
-- Apply as a superuser or BYPASSRLS role after 252. Re-runnable.
-- Asserted by supabase/ci/verify-merge-followups.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '253 must be applied by a superuser or BYPASSRLS role (the privacy hooks write contacts under RLS)';
  END IF;
  IF to_regclass('public.privacy_extensions') IS NULL THEN
    RAISE EXCEPTION '253: apply 229_desk_customer_contacts.sql first (privacy_extensions)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'lead_source_detail') THEN
    RAISE EXCEPTION '253: apply 249_lead_source_web_form.sql first (contacts.lead_source_detail)';
  END IF;
END $$;

-- ---------- 1. Push links (restates 205) ----------
CREATE OR REPLACE FUNCTION public.push_bell_url(n public.notifications)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_role    text;
  v_chat    text := CASE WHEN n.conversation_id IS NOT NULL THEN '/inbox?c=' || n.conversation_id END;
  v_contact text;
BEGIN
  SELECT p.account_role::text INTO v_role FROM public.profiles p
   WHERE p.user_id = n.user_id AND p.account_id = n.account_id AND p.deactivated_at IS NULL;
  CASE
    WHEN n.type IN ('conversation_assigned', 'ai_handoff', 'conversation_shared',
                    'insight_attention', 'chat_note_mention', 'response_target_missed',
                    'response_escalated', 'response_unassigned') THEN
      RETURN coalesce(v_chat, '/notifications');
    WHEN n.type IN ('task_assigned', 'task_due') THEN
      RETURN coalesce('/contacts/' || n.contact_id, v_chat, '/calls');
    WHEN n.type IN ('call_missed', 'callback_requested', 'call_outcome_due') THEN
      v_contact := coalesce(n.contact_id::text, n.meta ->> 'contact_id');
      RETURN CASE WHEN public.push_is_uuid(v_contact) THEN '/contacts/' || v_contact ELSE '/calls' END;
    WHEN n.type IN ('deal_room_join_request', 'deal_room_update') THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> 'room_id')
                  THEN '/chat/rooms/' || (n.meta ->> 'room_id') ELSE '/notifications' END;
    WHEN n.type IN ('channel_disconnected', 'channel_reconnected', 'meta_number_alert') THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin') THEN '/settings?tab=whatsapp' ELSE '/notifications' END;
    WHEN n.type IN ('pbx_connection_silent', 'pbx_connection_restored') THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin') THEN '/settings?tab=phone-system' ELSE '/notifications' END;
    WHEN n.type = 'team_activity_alert' THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin', 'team_leader') THEN '/team-activity' ELSE '/notifications' END;
    WHEN n.type = 'team_activity_unlock_request' THEN
      RETURN '/team-activity?tab=unlocks';
    WHEN n.type = 'team_activity_unlock_decided' THEN
      RETURN '/my-activity';
    WHEN n.type = 'meeting_invite' THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> 'meeting_id')
                  THEN '/meetings/' || (n.meta ->> 'meeting_id') ELSE '/notifications' END;
    WHEN n.type = 'submission_group_message' THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> 'group_id')
                  THEN '/submission-groups/' || (n.meta ->> 'group_id') ELSE '/notifications' END;
    ELSE
      RETURN '/notifications';
  END CASE;
END $$;

REVOKE ALL ON FUNCTION public.push_bell_url(public.notifications) FROM PUBLIC, anon, authenticated;

-- ---------- 2. PDPL: lead source in export and erase ----------
CREATE OR REPLACE FUNCTION public.privacy_lead_source_export(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce((SELECT jsonb_build_object('lead_source', c.lead_source,
                                             'lead_source_detail', c.lead_source_detail)
                     FROM public.contacts c
                    WHERE c.account_id = p_account AND c.id = p_contact), '{}'::jsonb)
$$;

CREATE OR REPLACE FUNCTION public.privacy_lead_source_erase(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.contacts c
     SET lead_source_detail = '{}'::jsonb
   WHERE c.account_id = p_account AND c.id = p_contact
     AND c.lead_source_detail <> '{}'::jsonb;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('counts', jsonb_build_object('contacts_lead_source_detail', v_n),
                            'objects', '[]'::jsonb);
END;
$$;

INSERT INTO public.privacy_extensions (name, export_fn, erase_fn, added_in)
VALUES ('lead_source', 'privacy_lead_source_export', 'privacy_lead_source_erase', '253')
ON CONFLICT (name) DO UPDATE SET export_fn = excluded.export_fn, erase_fn = excluded.erase_fn;

REVOKE ALL ON FUNCTION public.privacy_lead_source_export(uuid, uuid),
  public.privacy_lead_source_erase(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;
