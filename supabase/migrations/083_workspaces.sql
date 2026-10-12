-- 083_workspaces.sql — one person, several workspaces (SQL core)
--
-- Until now profiles.account_id was a person's only membership: one
-- profile per auth user (UNIQUE user_id, 001), so belonging to Taamul
-- Credit and TrafeeqPay at once meant two logins. This makes profiles
-- one row per (user, account) — a membership with its own role and
-- deactivation — and marks exactly one row per person `is_active`: the
-- workspace they are working in. switch_account() moves that mark.
--
-- Every existing policy keeps its meaning, "the caller's ACTIVE
-- account", because the three helpers they are built on now read the
-- active row only: is_account_member(), current_account_id() and
-- current_role_rank(). Nothing else changes for a person with one row.
--
-- `bank_guest` (082) is a membership that sees nothing: rank 0, never
-- an is_account_member(), and no current_account_id() while it is the
-- active row, so every account-scoped policy is closed to a guest.
-- my_workspaces() is SECURITY DEFINER because a guest cannot read
-- `accounts` through RLS. bank_code names the guest's bank.
--
-- Lookups of the caller's own profile by user_id alone become
-- multi-row with this change. In a policy's scalar subquery that is an
-- error ("more than one row returned"): the 080 deals policies now take
-- the caller's row in the active account. Other-user joins keyed on
-- user_id alone gain the account (team_activity_alert_sweep counted a
-- person once per membership; led_teammate_profile_ids listed every
-- membership's profile id), and the storage policies — which matched
-- the caller's profile in ANY account, a guest's included — read the
-- active, non-deactivated, non-guest row only.
--
-- switch_account() must work for a person whose active row is
-- deactivated (moving out is the point), which the 069 guard would
-- refuse; it raises the transaction-local `app.account_switch` flag for
-- its own UPDATEs (the 062 pattern). It changes no account_id, so the
-- 071 profiles_leave_account_teams trigger (UPDATE OF account_id) does
-- not fire: team memberships and number allocations survive a switch.
--
-- Section 11 moves the member RPCs (set_member_role, set_member_active,
-- transfer_account_ownership, remove_account_member, redeem_invitation,
-- provision_account_member) onto one membership each, and adds
-- create_workspace() and add_workspace_member().

-- ---------- 1. profiles: one row per (user, account) ----------
DO $$
DECLARE v_con text;
BEGIN
  FOR v_con IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.profiles'::regclass AND contype = 'u'
       AND pg_get_constraintdef(oid) = 'UNIQUE (user_id)'
  LOOP
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', v_con);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.profiles'::regclass
                    AND conname = 'profiles_user_account_key') THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_user_account_key UNIQUE (user_id, account_id);
  END IF;
END $$;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS bank_code text;

-- Existing rows are each their person's only row, so all stay active.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_one_active_per_user
  ON public.profiles (user_id) WHERE is_active;

-- A bank_guest row names its bank; no other row carries one.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.profiles'::regclass
                    AND conname = 'profiles_bank_code_guest_only') THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_bank_code_guest_only
      CHECK ((account_role = 'bank_guest') = (bank_code IS NOT NULL)
             AND (bank_code IS NULL OR btrim(bank_code) <> ''));
  END IF;
END $$;

-- ---------- 2. accounts: a short name, and owning several ----------
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS short_name text;

-- Initials of up to four words, upper-cased ("Taamul Credit" → TC).
CREATE OR REPLACE FUNCTION public.account_initials(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT NULLIF(upper(left(string_agg(left(w, 1), '' ORDER BY i), 4)), '')
    FROM regexp_split_to_table(btrim(coalesce(p_name, '')), '[^[:alnum:]]+')
         WITH ORDINALITY AS t(w, i)
   WHERE w <> '';
$$;

CREATE OR REPLACE FUNCTION public.accounts_fill_short_name()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.short_name IS NULL THEN
    NEW.short_name := account_initials(NEW.name);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounts_fill_short_name ON public.accounts;
CREATE TRIGGER accounts_fill_short_name
  BEFORE INSERT ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.accounts_fill_short_name();

UPDATE public.accounts SET short_name = account_initials(name)
 WHERE short_name IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.accounts'::regclass
                    AND conname = 'accounts_short_name_check') THEN
    ALTER TABLE public.accounts ADD CONSTRAINT accounts_short_name_check
      CHECK (short_name IS NULL
             OR (char_length(short_name) BETWEEN 1 AND 4
                 AND short_name = btrim(short_name)));
  END IF;
END $$;

-- 017 held a person to owning one account; a person may now own several.
DROP INDEX IF EXISTS public.idx_accounts_one_per_owner;

-- ---------- 3. the helpers read the ACTIVE row ----------
CREATE OR REPLACE FUNCTION public.is_account_member(
  target_account_id uuid,
  min_role account_role_enum DEFAULT 'viewer'
)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND p.is_active
      AND p.deactivated_at IS NULL
      AND p.account_role <> 'bank_guest'
      AND CASE p.account_role
            WHEN 'owner'       THEN 5
            WHEN 'admin'       THEN 4
            WHEN 'team_leader' THEN 3
            WHEN 'agent'       THEN 2
            WHEN 'viewer'      THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'       THEN 5
            WHEN 'admin'       THEN 4
            WHEN 'team_leader' THEN 3
            WHEN 'agent'       THEN 2
            WHEN 'viewer'      THEN 1
          END
  );
$$;

-- NULL for a guest: every `account_id = current_account_id()` policy
-- is closed to them. At most one row matches (profiles_one_active_per_user).
CREATE OR REPLACE FUNCTION public.current_account_id()
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT account_id FROM profiles
  WHERE user_id = auth.uid()
    AND is_active
    AND deactivated_at IS NULL
    AND account_role <> 'bank_guest'
$$;

-- bank_guest falls to ELSE 0.
CREATE OR REPLACE FUNCTION public.current_role_rank()
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE((
    SELECT CASE account_role
             WHEN 'owner'       THEN 5
             WHEN 'admin'       THEN 4
             WHEN 'team_leader' THEN 3
             WHEN 'agent'       THEN 2
             WHEN 'viewer'      THEN 1
             ELSE 0
           END
    FROM profiles
    WHERE user_id = auth.uid() AND is_active AND deactivated_at IS NULL
  ), 0)
$$;

-- ---------- 4. lookups keyed on user_id alone ----------
CREATE OR REPLACE FUNCTION public.led_teammate_profile_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(array_agg(p.id), '{}')
    FROM profiles p
   WHERE p.user_id = ANY (led_teammate_user_ids())
     AND p.account_id = current_account_id();
$$;

-- 080's deals policies, the caller's own profile taken in the active
-- account (the deal's: every policy also requires account_id =
-- current_account_id()). Kept uncorrelated so it stays one initplan.
DROP POLICY IF EXISTS deals_select ON public.deals;
CREATE POLICY deals_select ON public.deals
  FOR SELECT
  USING (
    account_id = (SELECT current_account_id())
    AND (
      (SELECT current_role_rank()) >= 4
      OR (assigned_to IS NULL AND user_id = (SELECT auth.uid()))
      OR assigned_to = (SELECT p.id FROM profiles p
                         WHERE p.user_id = (SELECT auth.uid())
                           AND p.account_id = (SELECT current_account_id()))
      OR ((SELECT current_role_rank()) = 3
          AND ((assigned_to IS NULL AND user_id = ANY ((SELECT led_teammate_user_ids())::uuid[]))
               OR assigned_to = ANY ((SELECT led_teammate_profile_ids())::uuid[])))
    )
  );

DROP POLICY IF EXISTS deals_insert ON public.deals;
CREATE POLICY deals_insert ON public.deals
  FOR INSERT
  WITH CHECK (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND (
      (SELECT current_role_rank()) >= 4
      OR (assigned_to IS NULL AND user_id = (SELECT auth.uid()))
      OR assigned_to = (SELECT p.id FROM profiles p
                         WHERE p.user_id = (SELECT auth.uid())
                           AND p.account_id = (SELECT current_account_id()))
      OR ((SELECT current_role_rank()) = 3
          AND ((assigned_to IS NULL AND user_id = ANY ((SELECT led_teammate_user_ids())::uuid[]))
               OR assigned_to = ANY ((SELECT led_teammate_profile_ids())::uuid[])))
    )
  );

DROP POLICY IF EXISTS deals_update ON public.deals;
CREATE POLICY deals_update ON public.deals
  FOR UPDATE
  USING (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND (
      (SELECT current_role_rank()) >= 4
      OR (assigned_to IS NULL AND user_id = (SELECT auth.uid()))
      OR assigned_to = (SELECT p.id FROM profiles p
                         WHERE p.user_id = (SELECT auth.uid())
                           AND p.account_id = (SELECT current_account_id()))
      OR ((SELECT current_role_rank()) = 3
          AND ((assigned_to IS NULL AND user_id = ANY ((SELECT led_teammate_user_ids())::uuid[]))
               OR assigned_to = ANY ((SELECT led_teammate_profile_ids())::uuid[])))
    )
  )
  WITH CHECK (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND (
      (SELECT current_role_rank()) >= 4
      OR (assigned_to IS NULL AND user_id = (SELECT auth.uid()))
      OR assigned_to = (SELECT p.id FROM profiles p
                         WHERE p.user_id = (SELECT auth.uid())
                           AND p.account_id = (SELECT current_account_id()))
      OR ((SELECT current_role_rank()) = 3
          AND ((assigned_to IS NULL AND user_id = ANY ((SELECT led_teammate_user_ids())::uuid[]))
               OR assigned_to = ANY ((SELECT led_teammate_profile_ids())::uuid[])))
    )
  );

DROP POLICY IF EXISTS deals_delete ON public.deals;
CREATE POLICY deals_delete ON public.deals
  FOR DELETE
  USING (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND (
      (SELECT current_role_rank()) >= 4
      OR (assigned_to IS NULL AND user_id = (SELECT auth.uid()))
      OR assigned_to = (SELECT p.id FROM profiles p
                         WHERE p.user_id = (SELECT auth.uid())
                           AND p.account_id = (SELECT current_account_id()))
      OR ((SELECT current_role_rank()) = 3
          AND ((assigned_to IS NULL AND user_id = ANY ((SELECT led_teammate_user_ids())::uuid[]))
               OR assigned_to = ANY ((SELECT led_teammate_profile_ids())::uuid[])))
    )
  );


-- 027 (latest body): the actor's name from their row in this account.
CREATE OR REPLACE FUNCTION public.notify_conversation_assigned()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contact_name TEXT;
  v_actor_name TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.assigned_agent_id IS NULL
       OR NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
      RETURN NEW;
    END IF;
  END IF;
  -- Skip self-assignment — nothing to notify the agent about.
  IF auth.uid() IS NOT NULL AND auth.uid() = NEW.assigned_agent_id THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
  FROM contacts WHERE id = NEW.contact_id;
  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name
    FROM profiles WHERE user_id = auth.uid() AND account_id = NEW.account_id;
  END IF;
  INSERT INTO notifications (
    account_id, user_id, type, conversation_id, contact_id,
    actor_user_id, title, body
  ) VALUES (
    NEW.account_id,
    NEW.assigned_agent_id,
    'conversation_assigned',
    NEW.id,
    NEW.contact_id,
    auth.uid(),
    'New conversation assigned',
    COALESCE(v_actor_name, 'Someone') || ' assigned you a conversation with '
      || COALESCE(v_contact_name, 'a contact')
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a notification failure block the assignment itself.
  RAISE WARNING 'Failed to create assignment notification for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$
;

-- 074 (latest body): the per-person count joined every membership of
-- the sender; now only their row in the account being swept.
CREATE OR REPLACE FUNCTION public.team_activity_alert_sweep()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account uuid;
  v_cfg     record;
  v_tz      text;
  v_today   timestamptz;
  v_day     date;
  r         record;
  v_alerts  integer := 0;
  v_notes   integer := 0;
  v_n       integer;
  v_nil     constant uuid := '00000000-0000-0000-0000-000000000000';
  l         record;
BEGIN
  FOR v_account IN
    SELECT DISTINCT c.account_id
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.created_at > now() - interval '25 hours'
      AND m.sender_type <> 'customer'
  LOOP
    SELECT * INTO v_cfg FROM team_activity_limits(v_account);
    -- Only once an admin has saved the limits: until then nobody has
    -- chosen them, and "today" would be the UTC day.
    CONTINUE WHEN NOT coalesce(v_cfg.saved, false) OR NOT coalesce(v_cfg.notify, true);
    v_tz := coalesce(v_cfg.timezone, 'UTC');
    v_today := date_trunc('day', now() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
    v_day := (now() AT TIME ZONE v_tz)::date;
    FOR r IN
      WITH s AS (
        SELECT * FROM team_activity_starts(v_account, v_today, 'infinity')
      )
      SELECT
        'user_daily_limit'::text AS kind,
        s.sender_id AS subject_id,
        count(*)::integer AS n,
        v_cfg.daily_new_chats_per_user AS lim,
        coalesce(max(nullif(btrim(p.full_name), '')), max(p.email), 'A team member') AS who
      FROM s
      LEFT JOIN profiles p ON p.user_id = s.sender_id AND p.account_id = v_account
      WHERE s.sender_type = 'agent' AND s.sender_id IS NOT NULL AND s.provider = 'whapi'
      GROUP BY s.sender_id
      HAVING count(*) >= v_cfg.daily_new_chats_per_user
      UNION ALL
      SELECT
        'number_daily_limit',
        w.id,
        count(*)::integer,
        team_activity_number_limit(max(w.created_at), v_cfg.daily_new_chats_per_number),
        coalesce(max(nullif(btrim(w.label), '')), max(w.waba_id), 'A WhatsApp number')
      FROM s
      JOIN whatsapp_config w
        ON w.id = s.channel_id AND w.account_id = v_account AND w.provider = 'whapi'
      GROUP BY w.id
      HAVING count(*) >= team_activity_number_limit(max(w.created_at), v_cfg.daily_new_chats_per_number)
    LOOP
      -- The leaders' copies first: they do not depend on whether the
      -- account-level alert went out on an earlier sweep.
      FOR l IN
        SELECT DISTINCT t.leader_user_id AS uid
        FROM teams t
        JOIN profiles p ON p.user_id = t.leader_user_id AND p.account_id = v_account
        WHERE t.account_id = v_account
          AND t.leader_user_id IS NOT NULL
          AND p.account_role = 'team_leader'
          AND t.leader_user_id IS DISTINCT FROM CASE WHEN r.kind = 'user_daily_limit' THEN r.subject_id END
          AND CASE WHEN r.kind = 'user_daily_limit'
                   THEN EXISTS (SELECT 1 FROM team_members tm
                                WHERE tm.team_id = t.id AND tm.user_id = r.subject_id)
                   ELSE EXISTS (SELECT 1 FROM whatsapp_channel_teams ct
                                WHERE ct.team_id = t.id AND ct.config_id = r.subject_id)
              END
      LOOP
        INSERT INTO team_activity_alerts (account_id, kind, subject_id, day, value, threshold, recipient_id)
        VALUES (v_account, r.kind, r.subject_id, v_day, r.n, r.lim, l.uid)
        ON CONFLICT DO NOTHING;
        CONTINUE WHEN NOT FOUND;
        INSERT INTO notifications (account_id, user_id, type, title, body)
        VALUES (
          v_account, l.uid, 'team_activity_alert',
          CASE WHEN r.kind = 'user_daily_limit'
               THEN 'Daily new-chat limit reached'
               ELSE 'A WhatsApp number reached its daily new-chat limit' END,
          CASE WHEN r.kind = 'user_daily_limit'
               THEN format('%s has started %s new chats today; the limit is %s. Unanswered first messages are the main reason WhatsApp restricts a number.', r.who, r.n, r.lim)
               ELSE format('%s has started %s new chats today; the limit is %s. Starting more today raises the risk of WhatsApp restricting this number.', r.who, r.n, r.lim) END);
        v_notes := v_notes + 1;
      END LOOP;
      INSERT INTO team_activity_alerts (account_id, kind, subject_id, day, value, threshold, recipient_id)
      VALUES (v_account, r.kind, r.subject_id, v_day, r.n, r.lim, v_nil)
      ON CONFLICT DO NOTHING;
      CONTINUE WHEN NOT FOUND;
      v_alerts := v_alerts + 1;
      IF r.kind = 'user_daily_limit' THEN
        INSERT INTO notifications (account_id, user_id, type, title, body)
        SELECT
          v_account, p.user_id, 'team_activity_alert',
          CASE WHEN p.user_id = r.subject_id
               THEN 'You have reached today''s new-chat limit'
               ELSE 'Daily new-chat limit reached' END,
          CASE WHEN p.user_id = r.subject_id
               THEN format('You have started %s new chats today; the limit is %s. Answer the chats you already have and start new ones tomorrow: unanswered first messages are the main reason WhatsApp restricts a number.', r.n, r.lim)
               ELSE format('%s has started %s new chats today; the limit is %s. Unanswered first messages are the main reason WhatsApp restricts a number.', r.who, r.n, r.lim) END
        FROM profiles p
        WHERE p.account_id = v_account
          AND (p.account_role IN ('owner', 'admin') OR p.user_id = r.subject_id);
      ELSE
        INSERT INTO notifications (account_id, user_id, type, title, body)
        SELECT
          v_account, p.user_id, 'team_activity_alert',
          'A WhatsApp number reached its daily new-chat limit',
          format('%s has started %s new chats today; the limit is %s. Starting more today raises the risk of WhatsApp restricting this number.', r.who, r.n, r.lim)
        FROM profiles p
        WHERE p.account_id = v_account
          AND p.account_role IN ('owner', 'admin');
      END IF;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_notes := v_notes + v_n;
    END LOOP;
  END LOOP;
  DELETE FROM team_activity_alerts WHERE created_at < now() - interval '90 days';
  RETURN jsonb_build_object('alerts', v_alerts, 'notifications', v_notes);
END
$function$
;

-- ---------- 5. the profile guard ----------
-- is_active and bank_code join the columns only a sanctioned writer may
-- change. The deactivated-caller check reads the caller's ACTIVE row: a
-- person deactivated in one workspace still works in another.
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user = 'authenticated' AND (
       TG_OP = 'INSERT'
       OR NEW.account_role IS DISTINCT FROM OLD.account_role
       OR NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.deactivated_at IS DISTINCT FROM OLD.deactivated_at
       OR NEW.deactivated_by IS DISTINCT FROM OLD.deactivated_by
       OR NEW.is_active IS DISTINCT FROM OLD.is_active
       OR NEW.bank_code IS DISTINCT FROM OLD.bank_code
     )
  THEN
    RAISE EXCEPTION
      'account_role, account_id and deactivation cannot be changed directly; use the account member/invitation RPCs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- switch_account() checked the caller itself, and moving out of a
  -- workspace where they were deactivated is what it is for; so is
  -- redeem_invitation(), whose token is the authority. Those are the
  -- only places this flag is raised; clients cannot set it.
  IF COALESCE(current_setting('app.account_switch', TRUE), '') = 'on' THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NOT NULL AND EXISTS (
       SELECT 1 FROM profiles
       WHERE user_id = auth.uid() AND is_active AND deactivated_at IS NOT NULL
     )
  THEN
    RAISE EXCEPTION 'Your access to this account has been deactivated'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

-- ---------- 6. switching ----------
CREATE OR REPLACE FUNCTION public.switch_account(p_account_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- One switch at a time per person.
  PERFORM 1 FROM profiles WHERE user_id = v_uid ORDER BY id FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1 FROM profiles
     WHERE user_id = v_uid
       AND account_id = p_account_id
       AND deactivated_at IS NULL
  ) THEN
    RAISE EXCEPTION 'You are not an active member of that workspace'
      USING ERRCODE = '42501';
  END IF;

  -- Demote, then promote: profiles_one_active_per_user is not deferrable.
  PERFORM set_config('app.account_switch', 'on', TRUE);
  UPDATE profiles SET is_active = false
   WHERE user_id = v_uid AND is_active AND account_id <> p_account_id;
  UPDATE profiles SET is_active = true
   WHERE user_id = v_uid AND account_id = p_account_id AND NOT is_active;
  PERFORM set_config('app.account_switch', '', TRUE);

  RETURN p_account_id;
END;
$$;

-- The switcher's list. A guest cannot read `accounts` through RLS.
CREATE OR REPLACE FUNCTION public.my_workspaces()
RETURNS TABLE (
  account_id  uuid,
  name        text,
  short_name  text,
  role        account_role_enum,
  is_active   boolean,
  deactivated boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT a.id, a.name, a.short_name, p.account_role, p.is_active,
         p.deactivated_at IS NOT NULL
    FROM profiles p
    JOIN accounts a ON a.id = p.account_id
   WHERE p.user_id = auth.uid()
   ORDER BY p.is_active DESC, a.name, a.id;
$$;

-- ---------- 7. one name across a person's rows ----------
-- Recursion ends by itself: the copies already hold the values, so the
-- nested trigger's UPDATE matches no row.
CREATE OR REPLACE FUNCTION public.profiles_propagate_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE profiles
     SET full_name = NEW.full_name,
         avatar_url = NEW.avatar_url,
         email = NEW.email
   WHERE user_id = NEW.user_id
     AND id <> NEW.id
     AND (full_name, avatar_url, email)
         IS DISTINCT FROM (NEW.full_name, NEW.avatar_url, NEW.email);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS profiles_propagate_identity ON public.profiles;
CREATE TRIGGER profiles_propagate_identity
  AFTER UPDATE OF full_name, avatar_url, email ON public.profiles
  FOR EACH ROW
  WHEN (OLD.full_name IS DISTINCT FROM NEW.full_name
        OR OLD.avatar_url IS DISTINCT FROM NEW.avatar_url
        OR OLD.email IS DISTINCT FROM NEW.email)
  EXECUTE FUNCTION public.profiles_propagate_identity();

-- ---------- 8. presence per workspace ----------
-- 024 keyed presence on user_id alone; a person is now online in every
-- workspace they may work in.
DO $$
BEGIN
  IF (SELECT array_agg(a.attname::text ORDER BY a.attname)
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.conrelid = 'public.member_presence'::regclass AND c.contype = 'p')
     IS DISTINCT FROM ARRAY['account_id', 'user_id'] THEN
    ALTER TABLE public.member_presence DROP CONSTRAINT IF EXISTS member_presence_pkey;
    ALTER TABLE public.member_presence
      ADD CONSTRAINT member_presence_pkey PRIMARY KEY (user_id, account_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.touch_presence(p_status text DEFAULT 'online')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('online', 'away') THEN
    RAISE EXCEPTION 'Invalid presence status: %', p_status
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'No account for caller' USING ERRCODE = '22023';
  END IF;

  INSERT INTO member_presence (user_id, account_id, status, last_seen_at)
  SELECT auth.uid(), p.account_id, p_status, now()
    FROM profiles p
   WHERE p.user_id = auth.uid() AND p.deactivated_at IS NULL
  ON CONFLICT (user_id, account_id) DO UPDATE
    SET status       = excluded.status,
        last_seen_at = now();
END;
$$;

-- ---------- 9. storage: the active workspace's folder only ----------
-- 020/023/057 matched the caller's profile in any account; the same
-- policies now take the active, non-deactivated, non-guest row.
DO $$
DECLARE
  r      record;
  v_pred text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('Members can read chat media',   'SELECT', 'chat-media', 'authenticated', false),
      ('Members can upload chat media', 'INSERT', 'chat-media', 'public',        false),
      ('Members can update chat media', 'UPDATE', 'chat-media', 'public',        false),
      ('Members can delete chat media', 'DELETE', 'chat-media', 'public',        false),
      ('Members can read flow media',   'SELECT', 'flow-media', 'authenticated', true),
      ('Members can upload flow media', 'INSERT', 'flow-media', 'public',        false),
      ('Members can update flow media', 'UPDATE', 'flow-media', 'public',        true),
      ('Members can delete flow media', 'DELETE', 'flow-media', 'public',        true)
    ) AS v(pol, cmd, bucket, rol, own_folder)
  LOOP
    v_pred := format(
      'bucket_id = %L AND (EXISTS (SELECT 1 FROM public.profiles p'
      ' WHERE p.user_id = auth.uid() AND p.is_active AND p.deactivated_at IS NULL'
      ' AND p.account_role <> ''bank_guest'''
      ' AND ''account-'' || p.account_id::text = (storage.foldername(objects.name))[1])%s)',
      r.bucket,
      CASE WHEN r.own_folder
           THEN ' OR auth.uid()::text = (storage.foldername(objects.name))[1]'
           ELSE '' END);
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', r.pol);
    EXECUTE format('CREATE POLICY %I ON storage.objects FOR %s TO %s %s (%s)',
      r.pol, r.cmd, r.rol,
      CASE WHEN r.cmd = 'INSERT' THEN 'WITH CHECK' ELSE 'USING' END, v_pred);
  END LOOP;
END $$;

-- ---------- 10. grants (057 style) ----------
REVOKE ALL ON FUNCTION public.switch_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.switch_account(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.my_workspaces() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_workspaces() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.account_initials(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_initials(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.profiles_propagate_identity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.accounts_fill_short_name() FROM PUBLIC, anon, authenticated;

-- ---------- 11. member RPCs: one membership at a time ----------
-- The six member RPCs read "the caller's profile" and "the target's
-- profile" by user_id alone (the first row of a multi-row person) and
-- wrote every row of the target. Each now takes the account from the
-- caller's ACTIVE row and reads or writes only the target's row in that
-- account. SQLSTATEs are unchanged: 42501 forbidden, 22023 bad input,
-- 23505 duplicate. A caller whose active row is deactivated is refused
-- up front with the 069 guard's own message, so no other refusal masks it.

-- The refusal for a target with no row in the caller's account: 42501
-- when they exist elsewhere, 22023 when they do not exist (as before).
CREATE OR REPLACE FUNCTION public.raise_not_a_member(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM profiles WHERE user_id = p_user_id) THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;
  RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
END;
$$;

-- The account a person leaves behind when they join another: their ONLY
-- row, in an account they own alone, with no data (the account
-- handle_new_user() or a legacy removal made). A person with a second
-- row gets NULL, so a workspace made with create_workspace() is never
-- discarded as a leftover. The data list is redeem_invitation's (019).
CREATE OR REPLACE FUNCTION public.disposable_personal_account(p_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT a.id
    FROM profiles p
    JOIN accounts a ON a.id = p.account_id
   WHERE p.user_id = p_user_id
     AND a.owner_user_id = p_user_id
     AND NOT EXISTS (SELECT 1 FROM profiles o
                      WHERE o.user_id = p_user_id AND o.id <> p.id)
     AND NOT EXISTS (SELECT 1 FROM profiles o
                      WHERE o.account_id = a.id AND o.user_id <> p_user_id)
     AND NOT EXISTS (
       SELECT 1 FROM contacts WHERE account_id = a.id
       UNION ALL SELECT 1 FROM conversations WHERE account_id = a.id
       UNION ALL SELECT 1 FROM broadcasts WHERE account_id = a.id
       UNION ALL SELECT 1 FROM automations WHERE account_id = a.id
       UNION ALL SELECT 1 FROM flows WHERE account_id = a.id
       UNION ALL SELECT 1 FROM pipelines WHERE account_id = a.id
       UNION ALL SELECT 1 FROM message_templates WHERE account_id = a.id
       UNION ALL SELECT 1 FROM tags WHERE account_id = a.id
       UNION ALL SELECT 1 FROM custom_fields WHERE account_id = a.id
       UNION ALL SELECT 1 FROM contact_notes WHERE account_id = a.id
       UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = a.id);
$$;

-- Role of the target's row in the caller's account. Staff <-> bank_guest
-- is refused: a guest row carries a bank_code (CHECK) and sees nothing,
-- so that change is remove + add_workspace_member, not a role edit.
CREATE OR REPLACE FUNCTION public.set_member_role(p_user_id uuid, p_new_role account_role_enum)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_caller_deactivated TIMESTAMPTZ;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT account_id, account_role, deactivated_at
    INTO v_caller_account_id, v_caller_role, v_caller_deactivated
    FROM profiles WHERE user_id = auth.uid() AND is_active;
  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF v_caller_deactivated IS NOT NULL THEN
    RAISE EXCEPTION 'Your access to this account has been deactivated'
      USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own role' USING ERRCODE = '22023';
  END IF;
  IF p_new_role IS NULL THEN
    RAISE EXCEPTION 'p_new_role is required' USING ERRCODE = '22023';
  END IF;

  SELECT account_role INTO v_target_role
    FROM profiles WHERE user_id = p_user_id AND account_id = v_caller_account_id;
  IF NOT FOUND THEN
    PERFORM raise_not_a_member(p_user_id);
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to demote an owner'
      USING ERRCODE = '22023';
  END IF;
  IF p_new_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to promote to owner'
      USING ERRCODE = '22023';
  END IF;
  IF (v_target_role = 'bank_guest') <> (p_new_role = 'bank_guest') THEN
    RAISE EXCEPTION 'A bank guest cannot become staff or staff a bank guest; remove the member and add them again'
      USING ERRCODE = '22023';
  END IF;

  UPDATE profiles SET account_role = p_new_role
   WHERE user_id = p_user_id AND account_id = v_caller_account_id;
END;
$$;

-- Deactivates the target's row in the caller's account only: their other
-- workspaces are untouched. It does not move their active mark; a person
-- whose active row is deactivated can still switch_account() away.
CREATE OR REPLACE FUNCTION public.set_member_active(p_user_id uuid, p_active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_caller_deactivated TIMESTAMPTZ;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT account_id, account_role, deactivated_at
    INTO v_caller_account_id, v_caller_role, v_caller_deactivated
    FROM profiles WHERE user_id = auth.uid() AND is_active;
  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF v_caller_deactivated IS NOT NULL THEN
    RAISE EXCEPTION 'Your access to this account has been deactivated'
      USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;
  IF p_active IS NULL THEN
    RAISE EXCEPTION 'p_active is required' USING ERRCODE = '22023';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot deactivate or reactivate yourself'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_role INTO v_target_role
    FROM profiles WHERE user_id = p_user_id AND account_id = v_caller_account_id;
  IF NOT FOUND THEN
    PERFORM raise_not_a_member(p_user_id);
  END IF;
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'The account owner cannot be deactivated'
      USING ERRCODE = '22023';
  END IF;

  IF p_active THEN
    UPDATE profiles SET deactivated_at = NULL, deactivated_by = NULL
     WHERE user_id = p_user_id AND account_id = v_caller_account_id;
  ELSE
    UPDATE profiles
       SET deactivated_at = COALESCE(deactivated_at, NOW()),
           deactivated_by = COALESCE(deactivated_by, auth.uid())
     WHERE user_id = p_user_id AND account_id = v_caller_account_id;
  END IF;
END;
$$;

-- Rows of the caller's account only. The new owner must be a working
-- member: not deactivated, not a bank guest.
CREATE OR REPLACE FUNCTION public.transfer_account_ownership(p_new_owner_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_caller_deactivated TIMESTAMPTZ;
  v_target_role account_role_enum;
  v_target_deactivated TIMESTAMPTZ;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT account_id, account_role, deactivated_at
    INTO v_caller_account_id, v_caller_role, v_caller_deactivated
    FROM profiles WHERE user_id = auth.uid() AND is_active;
  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF v_caller_deactivated IS NOT NULL THEN
    RAISE EXCEPTION 'Your access to this account has been deactivated'
      USING ERRCODE = '42501';
  END IF;
  IF v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the account owner can transfer ownership'
      USING ERRCODE = '42501';
  END IF;
  IF p_new_owner_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You are already the owner' USING ERRCODE = '22023';
  END IF;

  SELECT account_role, deactivated_at INTO v_target_role, v_target_deactivated
    FROM profiles
   WHERE user_id = p_new_owner_user_id AND account_id = v_caller_account_id;
  IF NOT FOUND THEN
    PERFORM raise_not_a_member(p_new_owner_user_id);
  END IF;
  IF v_target_deactivated IS NOT NULL THEN
    RAISE EXCEPTION 'The new owner must not be deactivated' USING ERRCODE = '22023';
  END IF;
  IF v_target_role = 'bank_guest' THEN
    RAISE EXCEPTION 'A bank guest cannot own an account' USING ERRCODE = '22023';
  END IF;

  -- Demote first; both writes are in this transaction.
  UPDATE profiles SET account_role = 'admin'
   WHERE user_id = auth.uid() AND account_id = v_caller_account_id;
  UPDATE profiles SET account_role = 'owner'
   WHERE user_id = p_new_owner_user_id AND account_id = v_caller_account_id;
  UPDATE accounts SET owner_user_id = p_new_owner_user_id
   WHERE id = v_caller_account_id;
END;
$$;

-- Deletes the target's row in the caller's account; the DELETE trigger
-- (profiles_leave_account_teams) clears their teams and number
-- allocations in that account only, and deals.assigned_to on that row
-- falls to NULL (FK). If it was their active row, their most recently
-- created other row becomes active, a non-deactivated one first. Their
-- ONLY row is moved to a fresh empty account instead (profile id and
-- login kept), and that account's id is returned; a person who keeps
-- another membership gets NULL (no account made). Before 083 the moved
-- row became that account's owner, and an owner may now
-- add_workspace_member and create_workspace: any removed member, a bank
-- guest included, would leave as someone who can pull logins in. So the
-- moved row is never owner or admin: a guest stays bank_guest (keeping
-- its bank_code, which the CHECK requires), anyone else becomes viewer.
-- Its deactivation is cleared, since no admin there could ever lift it.
CREATE OR REPLACE FUNCTION public.remove_account_member(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_caller_deactivated TIMESTAMPTZ;
  v_target_role account_role_enum;
  v_target_name TEXT;
  v_target_email TEXT;
  v_was_active BOOLEAN;
  v_new_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT account_id, account_role, deactivated_at
    INTO v_caller_account_id, v_caller_role, v_caller_deactivated
    FROM profiles WHERE user_id = auth.uid() AND is_active;
  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF v_caller_deactivated IS NOT NULL THEN
    RAISE EXCEPTION 'Your access to this account has been deactivated'
      USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  -- switch_account's per-person lock: the active mark read below stays true.
  PERFORM 1 FROM profiles WHERE user_id = p_user_id ORDER BY id FOR UPDATE;

  SELECT account_role, full_name, email
    INTO v_target_role, v_target_name, v_target_email
    FROM profiles WHERE user_id = p_user_id AND account_id = v_caller_account_id;
  IF NOT FOUND THEN
    PERFORM raise_not_a_member(p_user_id);
  END IF;
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM profiles
                  WHERE user_id = p_user_id AND account_id <> v_caller_account_id) THEN
    INSERT INTO accounts (name, owner_user_id)
    VALUES (COALESCE(NULLIF(v_target_name, ''), v_target_email, 'My account'), p_user_id)
    RETURNING id INTO v_new_account_id;
    UPDATE profiles
       SET account_id = v_new_account_id,
           account_role = CASE WHEN v_target_role = 'bank_guest'
                               THEN 'bank_guest' ELSE 'viewer' END::account_role_enum,
           bank_code = CASE WHEN v_target_role = 'bank_guest' THEN bank_code END,
           deactivated_at = NULL, deactivated_by = NULL, is_active = true
     WHERE user_id = p_user_id AND account_id = v_caller_account_id;
    RETURN v_new_account_id;
  END IF;

  DELETE FROM profiles
   WHERE user_id = p_user_id AND account_id = v_caller_account_id
  RETURNING is_active INTO v_was_active;

  IF v_was_active THEN
    UPDATE profiles SET is_active = true
     WHERE id = (SELECT id FROM profiles WHERE user_id = p_user_id
                  ORDER BY (deactivated_at IS NULL) DESC, created_at DESC, id DESC
                  LIMIT 1);
  END IF;
  RETURN NULL;
END;
$$;

-- Adds a row for the inviting account and makes it the caller's active
-- row. Other memberships and data no longer refuse: they stay, inactive.
-- Only a caller whose ONLY row is an empty personal account
-- (disposable_personal_account) has it discarded, by moving that row, as
-- before. Joining while the active row is deactivated is a move out of
-- that workspace, as in switch_account, so the guard's flag is raised for
-- the caller's own rows. Returns the inviting account's id.
CREATE OR REPLACE FUNCTION public.redeem_invitation(p_token_hash text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_personal UUID;
  v_name TEXT;
  v_email TEXT;
  v_avatar TEXT;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv FROM account_invitations
   WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed' USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;
  -- A guest row needs a bank_code, which an invitation does not carry.
  IF v_inv.role = 'bank_guest' THEN
    RAISE EXCEPTION 'A bank guest is added with add_workspace_member, not by invitation'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM profiles WHERE user_id = v_caller_id ORDER BY id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM profiles
              WHERE user_id = v_caller_id AND account_id = v_inv.account_id) THEN
    RAISE EXCEPTION 'You are already a member of this account' USING ERRCODE = '23505';
  END IF;

  v_personal := disposable_personal_account(v_caller_id);
  SELECT full_name, email, avatar_url INTO v_name, v_email, v_avatar
    FROM profiles WHERE user_id = v_caller_id
   ORDER BY is_active DESC, created_at DESC, id DESC LIMIT 1;

  PERFORM set_config('app.account_switch', 'on', TRUE);
  IF v_personal IS NOT NULL THEN
    UPDATE profiles
       SET account_id = v_inv.account_id, account_role = v_inv.role,
           is_active = true, deactivated_at = NULL, deactivated_by = NULL
     WHERE user_id = v_caller_id;
  ELSE
    -- Demote, then insert: profiles_one_active_per_user is not deferrable.
    UPDATE profiles SET is_active = false WHERE user_id = v_caller_id AND is_active;
    INSERT INTO profiles (user_id, full_name, email, avatar_url, account_id, account_role, is_active)
    VALUES (v_caller_id, v_name, v_email, v_avatar, v_inv.account_id, v_inv.role, true);
  END IF;
  PERFORM set_config('app.account_switch', '', TRUE);

  UPDATE account_invitations
     SET accepted_at = NOW(), accepted_by_user_id = v_caller_id
   WHERE id = v_inv.id;

  IF v_personal IS NOT NULL THEN
    DELETE FROM accounts WHERE id = v_personal;
  END IF;

  RETURN v_inv.account_id;
END;
$$;

-- Service role, right after the members API created a login: that new
-- person's only row is the empty account handle_new_user() made, which is
-- moved into p_account_id and discarded as before. Someone who already
-- has other rows gets one more row, inactive unless they have no active
-- row; nothing is deleted and their active mark stays where it is (the
-- 041 refusals for that case are gone). A bank_guest needs p_bank_code
-- and a brand-new login: that only row becomes the guest row, active, so
-- the login never holds a workspace of its own. An existing login is made
-- a guest with add_workspace_member. The 3-argument version is dropped so
-- no overload makes a named-argument call ambiguous.
DROP FUNCTION IF EXISTS public.provision_account_member(uuid, uuid, account_role_enum);
CREATE OR REPLACE FUNCTION public.provision_account_member(
  p_user_id uuid,
  p_account_id uuid,
  p_role account_role_enum,
  p_bank_code text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_code TEXT := NULLIF(btrim(p_bank_code), '');
  v_personal UUID;
  v_name TEXT;
  v_email TEXT;
  v_avatar TEXT;
BEGIN
  IF p_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot provision a member as owner; transfer ownership instead'
      USING ERRCODE = '22023';
  END IF;
  IF p_role = 'bank_guest' AND v_code IS NULL THEN
    RAISE EXCEPTION 'A bank guest needs a bank code' USING ERRCODE = '22023';
  END IF;
  IF p_role <> 'bank_guest' AND v_code IS NOT NULL THEN
    RAISE EXCEPTION 'Only a bank guest carries a bank code' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM profiles WHERE user_id = p_user_id ORDER BY id FOR UPDATE;
  IF NOT FOUND THEN
    -- handle_new_user() swallows its own failures with a WARNING.
    RAISE EXCEPTION 'No profile for user %; account bootstrap failed', p_user_id
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM profiles
              WHERE user_id = p_user_id AND account_id = p_account_id) THEN
    RAISE EXCEPTION 'User is already a member of this account' USING ERRCODE = '23505';
  END IF;

  v_personal := disposable_personal_account(p_user_id);
  IF p_role = 'bank_guest' AND v_personal IS NULL THEN
    RAISE EXCEPTION 'Only a new login is provisioned as a bank guest; add an existing person with add_workspace_member'
      USING ERRCODE = '22023';
  END IF;
  IF v_personal IS NOT NULL THEN
    -- Move the row BEFORE dropping the account (ON DELETE CASCADE). A
    -- deactivation belonged to the workspace being discarded, as in
    -- redeem_invitation: it does not follow the person into this one.
    UPDATE profiles
       SET account_id = p_account_id, account_role = p_role, bank_code = v_code,
           deactivated_at = NULL, deactivated_by = NULL
     WHERE user_id = p_user_id;
    DELETE FROM accounts WHERE id = v_personal;
    RETURN;
  END IF;

  SELECT full_name, email, avatar_url INTO v_name, v_email, v_avatar
    FROM profiles WHERE user_id = p_user_id
   ORDER BY is_active DESC, created_at DESC, id DESC LIMIT 1;
  INSERT INTO profiles (user_id, full_name, email, avatar_url, account_id, account_role, is_active)
  VALUES (p_user_id, v_name, v_email, v_avatar, p_account_id, p_role,
          NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = p_user_id AND is_active));
END;
$$;

-- A new workspace owned by the caller (an owner/admin of their active
-- workspace). The owner row is inactive: the client switches explicitly.
CREATE OR REPLACE FUNCTION public.create_workspace(p_name text, p_short_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role account_role_enum;
  v_deactivated TIMESTAMPTZ;
  v_full TEXT;
  v_email TEXT;
  v_avatar TEXT;
  v_name TEXT := btrim(p_name);
  v_short TEXT := btrim(p_short_name);
  v_id UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT account_role, deactivated_at, full_name, email, avatar_url
    INTO v_role, v_deactivated, v_full, v_email, v_avatar
    FROM profiles WHERE user_id = v_uid AND is_active;
  IF NOT FOUND OR v_deactivated IS NOT NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Creating a workspace requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;
  IF v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Workspace name must be 1 to 80 characters' USING ERRCODE = '22023';
  END IF;
  IF v_short IS NULL OR v_short !~ '^[A-Za-z0-9]{1,4}$' THEN
    RAISE EXCEPTION 'Short name must be 1 to 4 letters or digits' USING ERRCODE = '22023';
  END IF;

  INSERT INTO accounts (name, short_name, owner_user_id)
  VALUES (v_name, v_short, v_uid) RETURNING id INTO v_id;
  INSERT INTO profiles (user_id, full_name, email, avatar_url, account_id, account_role, is_active)
  VALUES (v_uid, v_full, v_email, v_avatar, v_id, 'owner', false);
  RETURN v_id;
END;
$$;

-- Adds an existing login (by email) to the caller's active workspace and
-- returns its user id. The row is inactive unless the person has no
-- active row. Only someone the caller already administers may be added:
-- a person with a live row in a workspace where the caller holds a live
-- owner/admin row (any of the caller's rows, not only the active one —
-- an owner bringing their RM from workspace A into workspace B). A member
-- of this workspace passes too, to be refused below as a duplicate: the
-- caller can list them anyway. Anyone else raises exactly what an unknown
-- email raises, P0002 'no_such_user', so the RPC never tells a caller
-- whether an address has a login, nor lets one pull in (and so read the
-- name of, and watch the presence of) a stranger. On that error the API
-- route tries to create the login (provision_account_member), which
-- GoTrue refuses for a registered address.
CREATE OR REPLACE FUNCTION public.add_workspace_member(
  p_email text,
  p_role account_role_enum,
  p_bank_code text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account UUID;
  v_role account_role_enum;
  v_deactivated TIMESTAMPTZ;
  v_code TEXT := NULLIF(btrim(p_bank_code), '');
  v_email_in TEXT := lower(btrim(p_email));
  v_user UUID;
  v_auth_email TEXT;
  v_meta JSONB;
  v_full TEXT;
  v_email TEXT;
  v_avatar TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT account_id, account_role, deactivated_at
    INTO v_account, v_role, v_deactivated
    FROM profiles WHERE user_id = auth.uid() AND is_active;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF v_deactivated IS NOT NULL THEN
    RAISE EXCEPTION 'Your access to this account has been deactivated'
      USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;
  IF v_email_in IS NULL OR v_email_in = '' THEN
    RAISE EXCEPTION 'An email is required' USING ERRCODE = '22023';
  END IF;
  IF p_role IS NULL OR p_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot add a member as owner; transfer ownership instead'
      USING ERRCODE = '22023';
  END IF;
  IF p_role = 'bank_guest' AND v_code IS NULL THEN
    RAISE EXCEPTION 'A bank guest needs a bank code' USING ERRCODE = '22023';
  END IF;
  IF p_role <> 'bank_guest' AND v_code IS NOT NULL THEN
    RAISE EXCEPTION 'Only a bank guest carries a bank code' USING ERRCODE = '22023';
  END IF;

  SELECT id, email, raw_user_meta_data INTO v_user, v_auth_email, v_meta
    FROM auth.users WHERE lower(email) = v_email_in
   ORDER BY created_at, id LIMIT 1;
  -- One error for "no login" and "not yours to add": see above.
  IF v_user IS NULL OR NOT (
       EXISTS (SELECT 1 FROM profiles WHERE user_id = v_user AND account_id = v_account)
       OR EXISTS (SELECT 1
                    FROM profiles t
                    JOIN profiles c ON c.account_id = t.account_id
                   WHERE t.user_id = v_user AND t.deactivated_at IS NULL
                     AND c.user_id = auth.uid() AND c.deactivated_at IS NULL
                     AND c.account_role IN ('owner', 'admin'))) THEN
    RAISE EXCEPTION 'no_such_user' USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1 FROM profiles WHERE user_id = v_user ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM profiles WHERE user_id = v_user AND account_id = v_account) THEN
    RAISE EXCEPTION 'That person is already a member of this workspace'
      USING ERRCODE = '23505';
  END IF;

  SELECT full_name, email, avatar_url INTO v_full, v_email, v_avatar
    FROM profiles WHERE user_id = v_user
   ORDER BY is_active DESC, created_at DESC, id DESC LIMIT 1;
  IF NOT FOUND THEN
    v_full := COALESCE(v_meta->>'full_name', '');
    v_email := COALESCE(v_auth_email, '');
  END IF;

  INSERT INTO profiles (user_id, full_name, email, avatar_url, account_id,
                        account_role, bank_code, is_active)
  VALUES (v_user, v_full, v_email, v_avatar, v_account, p_role, v_code,
          NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = v_user AND is_active));
  RETURN v_user;
END;
$$;

REVOKE ALL ON FUNCTION public.raise_not_a_member(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.disposable_personal_account(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_workspace(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_workspace(text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.add_workspace_member(text, account_role_enum, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_workspace_member(text, account_role_enum, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.provision_account_member(uuid, uuid, account_role_enum, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_account_member(uuid, uuid, account_role_enum, text) TO service_role;
COMMENT ON FUNCTION public.provision_account_member(uuid, uuid, account_role_enum, text) IS
  'Add p_user_id to p_account_id with p_role; a just-created login''s personal account is discarded. bank_guest takes p_bank_code and a new login only. Service-role only; see migrations 041 and 083.';
