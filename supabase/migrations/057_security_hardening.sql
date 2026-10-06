-- ============================================================
-- 057_security_hardening.sql — close the holes a schema audit found.
--
-- Every item below was exploitable through PostgREST / Storage with
-- nothing more than the public anon key (plus, for some, a session a
-- stranger could mint themselves while GoTrue signup was open — see
-- docs/docker.md: signup MUST be disabled on a deployment; the app
-- never uses it, members are provisioned with auth.admin.createUser).
--
--   1. profiles INSERT. `profiles_insert` let any authenticated user
--      write their OWN profile row with any account_id and
--      account_role — the 034 guard only covered UPDATE. A user with
--      no profile (a phone signup: `handle_new_user` inserts
--      NEW.email into a NOT NULL column, fails, and swallows the
--      error) could therefore insert themselves as 'owner' of any
--      tenant. Profiles are only ever created by `handle_new_user`,
--      `provision_account_member` and the invitation RPCs, all
--      SECURITY DEFINER — so the client policy goes, the guard
--      trigger covers INSERT too, and the signup trigger no longer
--      fails on a NULL email.
--
--   2. Storage listing. The "publicly readable" SELECT policies on
--      chat-media / flow-media / avatars had no TO clause, so `anon`
--      could LIST every tenant's folder (and so every account uuid
--      and every mirrored customer photo, voice note and document).
--      A public bucket serves /object/public/… without any policy;
--      the SELECT policy only added listing. Replaced with member-
--      scoped reads, which `upsert` and `remove` still need.
--
--   3. match_ai_knowledge_fts. 047 recreated it SECURITY DEFINER,
--      undoing 032: it filters only on the caller-supplied account
--      id, so any caller could read another tenant's knowledge base.
--      Back to SECURITY INVOKER (RLS scopes it; the bot runs as
--      service_role and bypasses RLS as before).
--
--   4. SECURITY DEFINER helpers with no auth check that were still
--      EXECUTE-able by anon/authenticated — Supabase's default
--      privileges grant EXECUTE on every new function to both, so
--      `REVOKE … FROM PUBLIC` alone never removed it. Anyone could
--      exhaust a conversation's AI reply cap, disable a tenant's
--      outbound webhook, or rewrite a broadcast's counters. Their
--      only callers are service-role code and DEFINER triggers.
--
--   5. Encrypted secrets readable by every member. ai_configs,
--      webhook_endpoints and api_keys are only read by admin screens
--      and service-role code, so SELECT becomes admin-only.
--      (whatsapp_config stays member-readable: the agent send path
--      reads its token through RLS. A follow-up can move that read to
--      the service role and add column grants.)
--
--   6. conversations INSERT only checked the agent role: an agent
--      could open a thread on a contact they can't see (which then
--      made the contact visible to them, bypassing 043), on another
--      tenant's contact, or pre-assigned to someone else (bypassing
--      the 042 assignment rule, which is BEFORE UPDATE only).
--
--   7. flow_runs (whose `vars` hold customer replies, and which is in
--      the realtime publication) and broadcast_recipients were
--      readable by every member, not scoped like the conversations
--      and contacts they describe. flow_run_events inherits the
--      flow_runs policy through its EXISTS.
--
--   8. accounts UPDATE let an admin rewrite owner_user_id, which the
--      member/invitation RPCs use for their safety checks. Column
--      grant: admins may rename the account and change its currency.
--
--   9. flow-media INSERT kept a legacy `<uid>/` path clause, letting
--      any authenticated user host arbitrary files in a public bucket
--      outside any account folder. New uploads all use the account
--      folder; the legacy clause stays on UPDATE/DELETE for old files.
--
-- Re-runnable: DROP … IF EXISTS / CREATE OR REPLACE / REVOKE / GRANT.
-- ============================================================


-- ---------- 1. profiles INSERT ----------

DROP POLICY IF EXISTS profiles_insert ON public.profiles;

CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user = 'authenticated' AND (
       TG_OP = 'INSERT'
       OR NEW.account_role IS DISTINCT FROM OLD.account_role
       OR NEW.account_id IS DISTINCT FROM OLD.account_id
     )
  THEN
    RAISE EXCEPTION
      'account_role and account_id cannot be changed directly; use the account member/invitation RPCs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_profile_privilege_columns() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_profile_privilege_columns ON public.profiles;
CREATE TRIGGER enforce_profile_privilege_columns
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_privilege_columns();

-- Same body as 017, but a NULL email (phone / anonymous identities)
-- no longer fails the NOT NULL profiles.email insert and leaves the
-- user without a profile.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_account_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');

  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, COALESCE(NEW.email, ''), v_account_id, 'owner');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;


-- ---------- 2. storage: no anonymous listing ----------

DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Members can read chat media" ON storage.objects;
CREATE POLICY "Members can read chat media"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Flow media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Members can read flow media" ON storage.objects;
CREATE POLICY "Members can read flow media"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'flow-media'
    AND (
      EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
      )
      OR auth.uid()::text = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Avatars are publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Users can read their own avatar" ON storage.objects;
CREATE POLICY "Users can read their own avatar"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'avatars'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- 9. flow-media INSERT: account folder only.
DROP POLICY IF EXISTS "Members can upload flow media" ON storage.objects;
CREATE POLICY "Members can upload flow media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'flow-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );


-- ---------- 3. knowledge search: SECURITY INVOKER again ----------

-- Body unchanged from 047.
CREATE OR REPLACE FUNCTION public.match_ai_knowledge_fts(
  p_account_id  uuid,
  p_query       text,
  p_match_count integer
)
RETURNS TABLE (id uuid, content text, rank real) AS $$
  WITH terms AS (
    SELECT DISTINCT lexeme
    FROM unnest(to_tsvector('simple', p_query))
    WHERE ts_lexize('english_stem', lexeme) <> '{}'
  ),
  q AS (
    SELECT to_tsquery('simple', string_agg(quote_literal(lexeme), ' | ')) AS tsq
    FROM terms
  )
  SELECT c.id,
         c.content,
         ts_rank(c.fts, q.tsq) AS rank
  FROM ai_knowledge_chunks c, q
  WHERE q.tsq IS NOT NULL
    AND c.account_id = p_account_id
    AND c.fts @@ q.tsq
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) TO authenticated, service_role;

DO $$
BEGIN
  IF to_regprocedure('public.match_ai_knowledge_semantic(uuid, text, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer) TO authenticated, service_role;
  END IF;
END $$;


-- ---------- 4. service-only DEFINER helpers ----------

REVOKE ALL ON FUNCTION public.claim_ai_reply_slot(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.record_webhook_failure(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_webhook_failure(uuid, integer) TO service_role;

-- Called only from broadcast_recipient_aggregate_trigger, itself
-- SECURITY DEFINER (runs as its owner), so the revoke can't break the
-- browser-side recipient inserts that fire it.
REVOKE ALL ON FUNCTION public._bcast_bump(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._bcast_bump(uuid, text, integer) TO service_role;

REVOKE ALL ON FUNCTION public.recompute_broadcast_counts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_broadcast_counts(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.merge_duplicate_contacts() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.merge_duplicate_conversations() FROM PUBLIC, anon, authenticated;

-- Member RPCs check auth.uid() themselves and reject a NULL caller;
-- anon has no business reaching them at all.
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.set_member_role(uuid, account_role_enum)',
    'public.remove_account_member(uuid)',
    'public.transfer_account_ownership(uuid)',
    'public.redeem_invitation(text)',
    'public.touch_presence(text)'
  ] LOOP
    IF to_regprocedure(f) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f);
    END IF;
  END LOOP;
END $$;


-- ---------- 5. secrets: admin-only reads ----------

DROP POLICY IF EXISTS ai_configs_select ON public.ai_configs;
CREATE POLICY ai_configs_select ON public.ai_configs FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS webhook_endpoints_select ON public.webhook_endpoints;
CREATE POLICY webhook_endpoints_select ON public.webhook_endpoints FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS api_keys_select ON public.api_keys;
CREATE POLICY api_keys_select ON public.api_keys FOR SELECT
  USING (is_account_member(account_id, 'admin'));


-- ---------- 6. conversations INSERT ----------

DROP POLICY IF EXISTS conversations_insert ON public.conversations;
CREATE POLICY conversations_insert ON public.conversations FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM public.contacts ct
      WHERE ct.id = conversations.contact_id
        AND ct.account_id = conversations.account_id
        AND can_view_contact(ct.account_id, ct.id, ct.user_id)
    )
    AND (
      assigned_agent_id IS NULL
      OR assigned_agent_id = auth.uid()
      OR is_account_member(account_id, 'admin')
      OR (
        is_account_member(account_id, 'team_leader')
        AND leads_teammate(account_id, assigned_agent_id)
      )
    )
  );


-- ---------- 7. flow_runs / broadcast_recipients scoping ----------

DROP POLICY IF EXISTS flow_runs_select ON public.flow_runs;
CREATE POLICY flow_runs_select ON public.flow_runs FOR SELECT
  USING (
    is_account_member(account_id, 'admin')
    OR EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = flow_runs.conversation_id
        AND can_view_conversation(c.account_id, c.user_id, c.assigned_agent_id)
    )
  );

-- Broadcasts are an admin-only screen (AdminOnlyLayout); the recipient
-- list is a map of which contacts were messaged, which 043 hides from
-- agents who don't handle them.
DROP POLICY IF EXISTS broadcast_recipients_select ON public.broadcast_recipients;
CREATE POLICY broadcast_recipients_select ON public.broadcast_recipients FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.broadcasts b
      WHERE b.id = broadcast_recipients.broadcast_id
        AND is_account_member(b.account_id, 'admin')
    )
  );


-- ---------- 8. accounts: column-limited UPDATE ----------

REVOKE UPDATE ON public.accounts FROM anon, authenticated;
DO $$
DECLARE
  cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ')
    INTO cols
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'accounts'
    AND column_name NOT IN ('id', 'owner_user_id', 'created_at');
  IF cols IS NOT NULL THEN
    EXECUTE format('GRANT UPDATE (%s) ON public.accounts TO authenticated', cols);
  END IF;
END $$;
