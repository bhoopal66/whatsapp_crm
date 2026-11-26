-- ============================================================
-- 317_hr_rest.sql — tasks that name a customer without pointing at them,
-- and HR templates saved over what another admin saved.
--
--  1. A task an HR rule opens carries the chat, never the contact (200,
--     header point 4), and a missed call from a number nobody had yet
--     carries only the call. privacy_subject_export and
--     privacy_subject_erase look for tasks by contact, so both were missed:
--     an erased candidate's tasks stayed, and a "Call back +971…" kept the
--     number. Both are registered in privacy_extensions (229). A call linked
--     to someone else keeps its task, as it keeps its recording (311).
--  2. hr_automsg_template_set gets an overload that also takes when the
--     shown row was saved (NULL: nothing was stored) and refuses STALE when
--     that is no longer what is stored. Without defaults, so a call without
--     p_expected, from the running build, keeps reaching the old one; the
--     old body stays in its own file.
--
-- Safe to run twice. Needs 229, 293, 311. supabase/ci/verify-hr-rest.sql
-- asserts it.
-- ============================================================

SET lock_timeout = '5s';

-- ---------- 1. tasks without a contact ----------

CREATE OR REPLACE FUNCTION public.privacy_unlinked_task_ids(p_account uuid, p_contact uuid)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH me AS (
    SELECT nullif(c.phone_normalized, '') AS phone
      FROM public.contacts c
     WHERE c.id = p_contact AND c.account_id = p_account)
  SELECT coalesce(array_agg(t.id), '{}')
    FROM me, public.tasks t
    -- The call a missed-call task was opened for, when it still exists.
    LEFT JOIN public.calls x
      ON t.source = 'pbx' AND x.account_id = p_account
     AND x.id = CASE WHEN t.source_ref ~ '^call:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
                     THEN substr(t.source_ref, 6)::uuid END
   WHERE t.account_id = p_account
     AND t.contact_id IS NULL
     AND (EXISTS (SELECT 1 FROM public.conversations v
                   WHERE v.id = t.conversation_id AND v.account_id = p_account AND v.contact_id = p_contact)
          OR (t.source = 'pbx'
              AND (x.contact_id = p_contact
                   -- 311's match, for a call linked to nobody.
                   OR (x.contact_id IS NULL
                       AND (x.meta -> 'contact_candidates' ? p_contact::text
                            OR me.phone = ANY (public.pbx_phone_variants(coalesce(x.remote_number, t.meta ->> 'remote_number')))
                            OR (length(me.phone) >= 8
                                AND length(coalesce(x.remote_number, t.meta ->> 'remote_number')) >= 8
                                AND right(coalesce(x.remote_number, t.meta ->> 'remote_number'), 8) = right(me.phone, 8)
                                AND NOT EXISTS (
                                      SELECT 1 FROM public.contacts o
                                       WHERE o.account_id = p_account
                                         AND o.phone_normalized = ANY (public.pbx_phone_variants(
                                               coalesce(x.remote_number, t.meta ->> 'remote_number'))))))))))
$$;

CREATE OR REPLACE FUNCTION public.privacy_unlinked_tasks_export(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH ids AS MATERIALIZED (SELECT public.privacy_unlinked_task_ids(p_account, p_contact) AS a)
  SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(t)) ORDER BY t.created_at), '[]'::jsonb)
    FROM ids JOIN public.tasks t ON t.id = ANY (ids.a)
$$;

CREATE OR REPLACE FUNCTION public.privacy_unlinked_tasks_erase(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids uuid[] := public.privacy_unlinked_task_ids(p_account, p_contact);
  v_n integer;
BEGIN
  DELETE FROM public.tasks t WHERE t.id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('counts', jsonb_build_object('tasks_without_contact', v_n), 'objects', '[]'::jsonb);
END;
$$;

INSERT INTO public.privacy_extensions (name, export_fn, erase_fn, added_in)
VALUES ('tasks_without_contact', 'privacy_unlinked_tasks_export', 'privacy_unlinked_tasks_erase', '317')
ON CONFLICT (name) DO UPDATE SET export_fn = excluded.export_fn, erase_fn = excluded.erase_fn;

REVOKE ALL ON FUNCTION public.privacy_unlinked_task_ids(uuid, uuid),
  public.privacy_unlinked_tasks_export(uuid, uuid),
  public.privacy_unlinked_tasks_erase(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;

-- ---------- 2. an HR template, over what the page showed ----------

CREATE OR REPLACE FUNCTION public.hr_automsg_template_set(
  p_kind text, p_language text, p_body text, p_meta_template_name text,
  p_approval_status text, p_category text, p_channel text,
  p_expected timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_account uuid;
  v_role text;
  v_stored timestamptz;
BEGIN
  SELECT o_account, o_role INTO v_account, v_role FROM hr_automsg_caller();
  IF v_role IS DISTINCT FROM 'admin' THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'only an admin may change automated-message templates');
  END IF;
  -- Two first saves find no row to lock.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    format('hr_automsg_template:%s:%s:%s:%s', v_account, p_kind, p_language, p_channel), 0));
  SELECT x.updated_at INTO v_stored
    FROM hr_automsg_templates x
   WHERE x.account_id = v_account AND x.kind = p_kind AND x.language = p_language AND x.channel = p_channel;
  IF v_stored IS DISTINCT FROM p_expected THEN
    PERFORM hr_refuse('STALE', 'the template was changed since it was loaded');
  END IF;
  RETURN hr_automsg_template_set(p_kind, p_language, p_body, p_meta_template_name,
                                 p_approval_status, p_category, p_channel);
END;
$$;

REVOKE ALL ON FUNCTION public.hr_automsg_template_set(text, text, text, text, text, text, text, timestamptz)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.hr_automsg_template_set(text, text, text, text, text, text, text, timestamptz)
  TO authenticated;

RESET lock_timeout;

NOTIFY pgrst, 'reload schema';
