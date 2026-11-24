-- ============================================================
-- 294_call_notes.sql — who may write a call's note after a transfer
--
-- A transferred call is answered by two people, and calls.user_id names
-- one: the latest answerer while it is live, the earliest once the legs
-- are merged. The other one's note was refused, and their wrap-up never
-- offered again. The PBX processor now keeps everyone who answered a
-- leg of a customer call (calls.meta.answered_user_ids, staff ids,
-- written by the service role only, stripped with meta on erasure).
-- Here each of them, in their ACTIVE account, may write the outcome and
-- note as the person on the call does, and may see that call: someone
-- an outbound call was transferred to did not ring (no rang_user_ids)
-- and saw nothing of it. The person alone, not their team leader, and
-- nobody else. calls.user_id, so every report, is unchanged.
--
-- Restates pbx_set_disposition (089) and pbx_can_view_call and
-- calls_select (198). Re-running 089 or 198 undoes it: apply in order.
-- Re-runnable.
-- ============================================================

SET lock_timeout = '5s';

-- The call's person, or anyone who answered a leg of it.
CREATE OR REPLACE FUNCTION public.pbx_answered_call(p_call public.calls)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(p_call.user_id = auth.uid(), false)
      OR COALESCE(jsonb_typeof(p_call.meta -> 'answered_user_ids') = 'array'
                  AND p_call.meta -> 'answered_user_ids' ? auth.uid()::text, false)
$$;
REVOKE ALL ON FUNCTION public.pbx_answered_call(public.calls) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.pbx_answered_call(public.calls) IS
  'The caller is the call''s person or answered a leg of it (meta.answered_user_ids). Says nothing of the account: its callers check that. Migration 294.';

CREATE OR REPLACE FUNCTION public.pbx_can_view_call(p_call public.calls)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_call.account_id IS NULL OR p_call.account_id IS DISTINCT FROM current_account_id() THEN false
    WHEN pbx_sees_all_calls() THEN true
    -- On the call, or it rang them; for a team leader, the same for a
    -- person of a team they lead.
    WHEN COALESCE(p_call.user_id = ANY (s.ppl), false)
      OR COALESCE(p_call.peer_user_id = ANY (s.ppl), false)
      OR (jsonb_typeof(p_call.meta -> 'rang_user_ids') = 'array'
          AND p_call.meta -> 'rang_user_ids' ?| s.ppl::text[]) THEN true
    -- Answered a leg of it (294): that person alone, not their leader.
    WHEN jsonb_typeof(p_call.meta -> 'answered_user_ids') = 'array'
      AND p_call.meta -> 'answered_user_ids' ? auth.uid()::text THEN true
    WHEN p_call.contact_id IS NOT NULL THEN EXISTS (
      SELECT 1 FROM contacts c
       WHERE c.id = p_call.contact_id
         AND can_view_contact(c.account_id, c.id, c.user_id))
    ELSE false
  END
  FROM (SELECT pbx_visible_user_ids() AS ppl) s
$$;

DROP POLICY IF EXISTS calls_select ON public.calls;
CREATE POLICY calls_select ON public.calls
  FOR SELECT TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND ((SELECT public.pbx_sees_all_calls())
         OR user_id = ANY ((SELECT public.pbx_visible_user_ids())::uuid[])
         OR peer_user_id = ANY ((SELECT public.pbx_visible_user_ids())::uuid[])
         OR (jsonb_typeof(meta -> 'rang_user_ids') = 'array'
             AND (meta -> 'rang_user_ids') ?| (SELECT public.pbx_visible_user_ids()::text[]))
         OR (jsonb_typeof(meta -> 'answered_user_ids') = 'array'
             AND (meta -> 'answered_user_ids') ? (SELECT auth.uid()::text))
         OR contact_id IN (SELECT public.pbx_visible_contact_ids()))
  );

CREATE OR REPLACE FUNCTION public.pbx_set_disposition(p_call_id uuid, p_disposition text, p_notes text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_call  calls;
  v_notes text := NULLIF(btrim(p_notes), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_call FROM calls WHERE id = p_call_id FOR UPDATE;
  IF NOT FOUND OR NOT pbx_can_view_call(v_call) THEN
    RAISE EXCEPTION 'Call not found' USING ERRCODE = 'P0002';
  END IF;
  IF current_role_rank() < 3
     AND NOT (pbx_answered_call(v_call) AND current_role_rank() >= 2) THEN
    RAISE EXCEPTION 'Only the person on the call or a team leader can record its outcome'
      USING ERRCODE = '42501';
  END IF;
  IF p_disposition IS NOT NULL
     AND p_disposition NOT IN ('interested', 'docs_requested', 'call_back', 'not_eligible', 'wrong_number') THEN
    RAISE EXCEPTION 'Unknown disposition %', p_disposition USING ERRCODE = '22023';
  END IF;
  IF char_length(v_notes) > 4000 THEN
    RAISE EXCEPTION 'Notes are limited to 4000 characters' USING ERRCODE = '22023';
  END IF;
  IF v_call.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'This call was erased' USING ERRCODE = '55000';
  END IF;
  UPDATE calls
     SET disposition = p_disposition,
         notes = v_notes,
         notes_updated_by = auth.uid(),
         notes_updated_at = now()
   WHERE id = p_call_id;
END;
$$;
