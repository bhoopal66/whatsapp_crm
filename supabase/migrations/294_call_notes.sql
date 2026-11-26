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
-- With several people writing one note, a save must not overwrite what
-- it never read: pbx_save_call_note writes only the fields it is sent,
-- and a note only over the text its writer last saw. pbx_set_disposition
-- writes both fields blind; it stays for a build still running.
--
-- And each of them may say who the customer was: pbx_link_call_contact
-- lets someone else who answered FILL a call's contact (the pick on the
-- incoming-call card, the new-caller form). Moving a call off the contact
-- it has stays with the call's person and a team leader.
--
-- Restates pbx_set_disposition and pbx_link_call_contact (089) and
-- pbx_can_view_call and calls_select (198). Re-running 089 or 198 undoes
-- it: apply in order.
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

-- One block, so one transaction: committed apart, a CREATE that waits out
-- the lock timeout would leave calls with no SELECT policy at all.
DO $$ BEGIN
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
END $$;

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

CREATE OR REPLACE FUNCTION public.pbx_link_call_contact(p_call_id uuid, p_contact_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_call    calls;
  v_contact contacts;
BEGIN
  IF auth.uid() IS NULL OR current_role_rank() < 2 THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_call FROM calls WHERE id = p_call_id FOR UPDATE;
  IF NOT FOUND OR NOT pbx_can_view_call(v_call) THEN
    RAISE EXCEPTION 'Call not found' USING ERRCODE = 'P0002';
  END IF;
  -- The disposition's rule: seeing a call through its customer is not
  -- enough to move another person's call. Someone else who answered a leg
  -- of it only fills an empty contact (the same one again: a retry).
  IF current_role_rank() < 3
     AND NOT COALESCE(v_call.user_id = auth.uid(), false)
     AND NOT (pbx_answered_call(v_call)
              AND COALESCE(v_call.contact_id = p_contact_id, true)) THEN
    RAISE EXCEPTION 'Only the person on the call or a team leader can re-link it'
      USING ERRCODE = '42501';
  END IF;
  IF v_call.direction = 'internal' THEN
    RAISE EXCEPTION 'An internal call has no customer' USING ERRCODE = '22023';
  END IF;
  IF v_call.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'This call was erased' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_contact FROM contacts WHERE id = p_contact_id;
  IF NOT FOUND OR v_contact.account_id IS DISTINCT FROM v_call.account_id
     OR NOT can_view_contact(v_contact.account_id, v_contact.id, v_contact.user_id) THEN
    RAISE EXCEPTION 'Contact not found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE calls
     SET contact_id = p_contact_id,
         conversation_id = (SELECT cv.id FROM conversations cv
                             WHERE cv.contact_id = p_contact_id AND cv.account_id = v_call.account_id
                             ORDER BY cv.created_at DESC, cv.id LIMIT 1),
         deal_id = CASE WHEN EXISTS (SELECT 1 FROM deals d
                                      WHERE d.id = v_call.deal_id AND d.contact_id = p_contact_id)
                        THEN v_call.deal_id END
   WHERE id = p_call_id;
END;
$$;

-- Saves a call's outcome, its note, or both: p_fields holds only what is
-- to be written ({disposition?, notes?, notes_seen?}; a key that is not
-- there is left alone, null clears). notes_seen is the text the writer
-- last saw (null: an empty note). A stored note that is neither that text
-- nor the new one (a retry after a lost answer) is someone else's work:
-- nothing is written and the answer is {conflict: true, notes: <stored>}.
-- It is an answer and not an error so the note never reaches the logs.
-- Compared as text, not by notes_updated_at: pbx_set_disposition stamps
-- that on an outcome too. Without notes_seen (a browser tab older than
-- this) the note is written only over an empty one or the writer's own.
-- notes_updated_* is stamped only when the note changes.
CREATE OR REPLACE FUNCTION public.pbx_save_call_note(p_call_id uuid, p_fields jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_call   calls;
  v_notes  text := NULLIF(btrim(p_fields ->> 'notes'), '');
  v_seen   text := NULLIF(btrim(p_fields ->> 'notes_seen'), '');
  v_stored text;
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
  IF jsonb_typeof(p_fields) IS DISTINCT FROM 'object'
     OR NOT p_fields ?| ARRAY['disposition', 'notes']
     OR jsonb_typeof(p_fields -> 'disposition') NOT IN ('string', 'null')
     OR jsonb_typeof(p_fields -> 'notes') NOT IN ('string', 'null')
     OR jsonb_typeof(p_fields -> 'notes_seen') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'Nothing to change' USING ERRCODE = '22023';
  END IF;
  IF p_fields ->> 'disposition' NOT IN
     ('interested', 'docs_requested', 'call_back', 'not_eligible', 'wrong_number') THEN
    RAISE EXCEPTION 'Unknown disposition' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_notes) > 4000 THEN
    RAISE EXCEPTION 'Notes are limited to 4000 characters' USING ERRCODE = '22023';
  END IF;
  IF v_call.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'This call was erased' USING ERRCODE = '55000';
  END IF;

  IF p_fields ? 'notes' THEN
    v_stored := NULLIF(btrim(v_call.notes), '');
    IF v_notes IS DISTINCT FROM v_stored THEN
      IF NOT (CASE WHEN p_fields ? 'notes_seen'
                   THEN v_seen IS NOT DISTINCT FROM v_stored
                   ELSE v_stored IS NULL
                        OR COALESCE(v_call.notes_updated_by = auth.uid(), false) END) THEN
        RETURN jsonb_build_object('conflict', true, 'notes', v_stored);
      END IF;
      UPDATE calls
         SET notes = v_notes,
             notes_updated_by = auth.uid(),
             notes_updated_at = now()
       WHERE id = p_call_id
       RETURNING * INTO v_call;
    END IF;
  END IF;
  IF p_fields ? 'disposition' THEN
    UPDATE calls
       SET disposition = p_fields ->> 'disposition'
     WHERE id = p_call_id
     RETURNING * INTO v_call;
  END IF;
  RETURN jsonb_build_object(
    'disposition', v_call.disposition,
    'notes', v_call.notes,
    'notes_updated_at', v_call.notes_updated_at);
END;
$$;
REVOKE ALL ON FUNCTION public.pbx_save_call_note(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pbx_save_call_note(uuid, jsonb) TO authenticated, service_role;
