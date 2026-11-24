-- ============================================================
-- 280_contact_delete.sql — deleting a customer: the opt-out outlives the
-- row, and open work refuses the delete.
--
--  1. contact_suppressions: one row per (account, number) that left a
--     contact carrying an opt-out (076) or a do-not-contact (086): a delete,
--     a change of number, a PDPL erase. The number is kept only as an HMAC
--     (key in contact_suppression_keys, one row, made once, no grants), so
--     neither an app reader nor the service role can read it back; whoever
--     holds the whole database could still test guessed numbers, which is
--     what a suppression list must be able to answer. The hash is of one
--     canonical form, so 0501234567, 501234567, 00971…, 0971…, 9710… and
--     +971 50… are one number: a number with no country code is taken for a
--     UAE one (as normalizeSalesPhone does), unless it was typed with a +.
--     phone_normalized alone (022) would miss the local form, and a last-8
--     match (phonesMatch) cannot be hashed without matching strangers.
--     Never a name, never the do-not-contact reason (free text about a
--     person, which the number's next holder would be shown).
--     contact_id, set on a change of number only, says whose kept row it is:
--       a. going back to a number the contact left undoes a mistyped one:
--          that kept row goes and nothing is kept for the number undone
--          (nor when the kept row already says exactly what the contact
--          says: a re-added customer whose number was mistyped).
--       b. 3 and 6 reach the numbers the contact left before.
--     A row another contact also wrote belongs to nobody (NULL), so that
--     lifting one customer's opt-out cannot lift a stranger's.
--  2. A new contact, or one given that number, gets the two stamps back if
--     its own are empty, with ONE consent event of kind 'restored'. One primary
--     key look-up per row. The stamps are set BEFORE INSERT, after 076's and
--     086's guards (triggers fire by name), so an agent may add the number
--     and INSERT … RETURNING already shows it opted out.
--  3. Lifting a stamp on a contact clears the kept one, for its number and
--     for the numbers it left.
--  4. contacts_open_work_guard: a signed-in person cannot delete a customer
--     with an open case, open deal room or active submission group
--     (ZC280, HINT HAS_OPEN_WORK, DETAIL = the counts as JSON). Not
--     guarded: a deletion of the whole account, and statements with no
--     signed-in user or the service role (076's rule; no server code
--     deletes contacts today, and removing a login cascades that way). A
--     PDPL erase anonymises the row, so it is never a delete.
--  5. contact_delete_preview(ids): counts only, for the contacts the caller
--     may delete (059's contacts_delete). Definer, because what goes with a
--     customer is not limited to what the caller can read.
--  6. privacy_extensions: exported; the erase (by number and by contact)
--     drops who deleted it and whose it was, and keeps the hash and dates.
--
-- RESTATES 086's contacts_consent_log (function and trigger): apply in
-- order, once (re-running 086 afterwards reverts it; re-run 280 after it).
-- Apply after 262 as a superuser or BYPASSRLS role, before the build, with
-- ON_ERROR_STOP: psql goes on after an error. A statement that failed on
-- the lock timeout is safe to re-run; contacts_consent_log refuses to be
-- replaced while the events' CHECK would refuse its 'restored'.
-- Every trigger is replaced in one statement: a lock timeout leaves the one
-- that was there.
-- Re-runnable. verify-contact-delete.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '280 must be applied by a superuser or BYPASSRLS role';
  END IF;
  IF to_regprocedure('public.contacts_legal_hold_guard()') IS NULL THEN
    RAISE EXCEPTION '280: apply 262_privacy_fixes.sql first';
  END IF;
END $$;

-- ---------- 1. The kept stamps ----------

CREATE TABLE IF NOT EXISTS public.contact_suppression_keys (
  id      boolean PRIMARY KEY DEFAULT true CHECK (id),
  secret  bytea NOT NULL
);
ALTER TABLE public.contact_suppression_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_suppression_keys FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_suppression_keys FROM PUBLIC, anon, authenticated, service_role;
-- Never replaced: a new key would orphan every kept row.
INSERT INTO public.contact_suppression_keys (secret) VALUES (extensions.gen_random_bytes(32)) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.contact_suppressions (
  account_id         uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  phone_hash         bytea NOT NULL,
  opted_out_at       timestamptz NULL,
  do_not_contact_at  timestamptz NULL,
  consent_events     jsonb NOT NULL DEFAULT '[]'::jsonb,
  via                text NOT NULL CHECK (via IN ('delete', 'erase', 'phone_change')),
  deleted_at         timestamptz NOT NULL DEFAULT now(),
  deleted_by         uuid NULL,
  contact_id         uuid NULL REFERENCES public.contacts(id) ON DELETE SET NULL,
  PRIMARY KEY (account_id, phone_hash),
  CONSTRAINT contact_suppressions_who CHECK ((deleted_by IS NULL OR via = 'delete')
    AND (contact_id IS NULL OR via = 'phone_change')),
  CONSTRAINT contact_suppressions_stamp CHECK (opted_out_at IS NOT NULL OR do_not_contact_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS contact_suppressions_contact ON public.contact_suppressions (contact_id)
  WHERE contact_id IS NOT NULL;
ALTER TABLE public.contact_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_suppressions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_suppressions FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.contact_suppressions IS
  'Opt-outs and do-not-contacts of numbers whose contact is gone, by keyed hash. Definer functions only. Migration 280.';

-- One form per number; NULL when it identifies nobody (an erased row's
-- 'erased-…', too short). 022's phone_normalized is not computed yet in a
-- BEFORE trigger, hence the raw phone.
-- 971 and 8 digits or more carries the country code; a + before the first
-- digit says the number does, so it is never a local one.
-- plpgsql, not SQL: the plans are cached, so a large import stays fast.
CREATE OR REPLACE FUNCTION public.contact_suppression_number(p_phone text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  d text := regexp_replace(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '^00', '');
  n text := ltrim(d, '0');
BEGIN
  RETURN CASE WHEN p_phone LIKE 'erased-%' OR length(n) < 7 THEN NULL
              WHEN n LIKE '971%' AND length(n) >= 11 THEN '971' || ltrim(substr(n, 4), '0')
              WHEN p_phone !~ '^[^0-9]*[+]' AND (d LIKE '0%' OR length(n) <= 9) THEN '971' || n
              ELSE n END;
END;
$$;

CREATE OR REPLACE FUNCTION public.contact_suppression_hash(p_account uuid, p_phone text)
RETURNS bytea
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  n text := public.contact_suppression_number(p_phone);
BEGIN
  IF n IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN extensions.hmac(convert_to(p_account::text || ':' || n, 'UTF8'),
                         (SELECT k.secret FROM public.contact_suppression_keys k), 'sha256');
END;
$$;

-- BEFORE DELETE: the consent events are still there to be summarised.
CREATE OR REPLACE FUNCTION public.contacts_suppression_keep()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_hash bytea := public.contact_suppression_hash(OLD.account_id, OLD.phone);
  v_new  bytea;
  v_via  text := 'delete';
  v_ev   jsonb;
  s      public.contact_suppressions%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_new := public.contact_suppression_hash(NEW.account_id, NEW.phone);
    IF v_hash IS NOT DISTINCT FROM v_new THEN
      RETURN NEW;
    END IF;
    -- Undone (1a): its own row goes; a row of nobody stays for the number.
    SELECT * INTO s FROM public.contact_suppressions x
     WHERE x.account_id = NEW.account_id AND x.phone_hash = v_new;
    IF FOUND AND (s.contact_id = OLD.id
                  OR (s.opted_out_at IS NOT DISTINCT FROM OLD.opted_out_at
                      AND s.do_not_contact_at IS NOT DISTINCT FROM OLD.do_not_contact_at)) THEN
      DELETE FROM public.contact_suppressions x
       WHERE x.account_id = NEW.account_id AND x.phone_hash = v_new AND x.contact_id = OLD.id;
      RETURN NEW;
    END IF;
    v_via := CASE WHEN NEW.phone LIKE 'erased-%' THEN 'erase' ELSE 'phone_change' END;
  END IF;
  -- The whole account going: nothing is left to suppress.
  IF v_hash IS NOT NULL AND EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = OLD.account_id) THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('kind', e.kind, 'source', e.source, 'at', e.at) ORDER BY e.at), '[]')
      INTO v_ev
      FROM (SELECT x.kind, x.source, x.at FROM public.contact_consent_events x
             WHERE x.contact_id = OLD.id ORDER BY x.at DESC LIMIT 5) e;
    INSERT INTO public.contact_suppressions AS k (account_id, phone_hash, opted_out_at, do_not_contact_at,
      consent_events, via, deleted_at, deleted_by, contact_id)
    VALUES (OLD.account_id, v_hash, OLD.opted_out_at, OLD.do_not_contact_at, v_ev, v_via, now(),
      CASE WHEN v_via = 'delete' THEN auth.uid() END, CASE WHEN v_via = 'phone_change' THEN OLD.id END)
    ON CONFLICT (account_id, phone_hash) DO UPDATE
      SET opted_out_at = coalesce(excluded.opted_out_at, k.opted_out_at),
          do_not_contact_at = coalesce(excluded.do_not_contact_at, k.do_not_contact_at),
          consent_events = excluded.consent_events, via = excluded.via,
          deleted_at = excluded.deleted_at, deleted_by = excluded.deleted_by,
          -- Two contacts' stamps in one row: nobody's to lift from afar.
          contact_id = NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER contacts_suppression_keep BEFORE DELETE OR UPDATE OF phone ON public.contacts
  FOR EACH ROW WHEN (OLD.opted_out_at IS NOT NULL OR OLD.do_not_contact_at IS NOT NULL)
  EXECUTE FUNCTION public.contacts_suppression_keep();

-- ---------- 2. Restored on re-add ----------

-- Named to fire after contacts_consent_guard and contacts_opt_out_guard.
CREATE OR REPLACE FUNCTION public.contacts_suppression_restore()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  s      public.contact_suppressions%ROWTYPE;
  v_hash bytea;
BEGIN
  IF TG_OP = 'UPDATE' AND public.contact_suppression_number(OLD.phone)
       IS NOT DISTINCT FROM public.contact_suppression_number(NEW.phone) THEN
    RETURN NEW;
  END IF;
  v_hash := public.contact_suppression_hash(NEW.account_id, NEW.phone);
  SELECT * INTO s FROM public.contact_suppressions x
   WHERE x.account_id = NEW.account_id AND x.phone_hash = v_hash;
  IF FOUND THEN
    NEW.opted_out_at := coalesce(NEW.opted_out_at, s.opted_out_at);
    NEW.do_not_contact_at := coalesce(NEW.do_not_contact_at, s.do_not_contact_at);
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER contacts_suppression_restore BEFORE INSERT OR UPDATE OF phone ON public.contacts
  FOR EACH ROW WHEN (NEW.opted_out_at IS NULL OR NEW.do_not_contact_at IS NULL)
  EXECUTE FUNCTION public.contacts_suppression_restore();

-- One statement: a lock timeout leaves the old CHECK, never none.
ALTER TABLE public.contact_consent_events DROP CONSTRAINT IF EXISTS contact_consent_events_kind_check,
  ADD CONSTRAINT contact_consent_events_kind_check CHECK (kind IN (
  'marketing_opt_in', 'marketing_opt_in_withdrawn', 'opted_out', 'resubscribed',
  'do_not_contact_set', 'do_not_contact_cleared', 'restored'));

-- 086's, plus: a stamp equal to the kept one on a contact that just took
-- its number is a restore, not a decision of whoever added the contact.
DO $guard$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k
                  WHERE k.conrelid = 'public.contact_consent_events'::regclass AND k.contype = 'c'
                    AND k.conname = 'contact_consent_events_kind_check' AND pg_get_constraintdef(k.oid) LIKE '%''restored''%') THEN
    RAISE EXCEPTION '280: contact_consent_events does not allow ''restored'' yet, so contacts_consent_log stays as it is: re-run 280';
  END IF;
  EXECUTE $create$
CREATE OR REPLACE FUNCTION public.contacts_consent_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $log$
DECLARE
  v_actor  uuid := auth.uid();
  v_source text;
  o_optin  timestamptz;
  o_out    timestamptz;
  o_dnc    timestamptz;
  v_out    boolean;
  v_dnc    boolean;
  s        public.contact_suppressions%ROWTYPE;
BEGIN
  v_source := coalesce(
    nullif(current_setting('app.consent_source', true), ''),
    CASE WHEN v_actor IS NULL OR COALESCE(auth.role(), '') = 'service_role'
         THEN 'system' ELSE 'manual' END);
  IF tg_op = 'UPDATE' THEN
    o_optin := old.marketing_opt_in_at;
    o_out   := old.opted_out_at;
    o_dnc   := old.do_not_contact_at;
  END IF;
  v_out := new.opted_out_at IS DISTINCT FROM o_out;
  v_dnc := new.do_not_contact_at IS DISTINCT FROM o_dnc;

  IF ((v_out AND new.opted_out_at IS NOT NULL) OR (v_dnc AND new.do_not_contact_at IS NOT NULL))
     AND (tg_op = 'INSERT' OR new.phone IS DISTINCT FROM old.phone) THEN
    SELECT * INTO s FROM public.contact_suppressions x
     WHERE x.account_id = new.account_id
       AND x.phone_hash = public.contact_suppression_hash(new.account_id, new.phone);
    IF FOUND AND ((v_out AND new.opted_out_at = s.opted_out_at)
                  OR (v_dnc AND new.do_not_contact_at = s.do_not_contact_at)) THEN
      INSERT INTO public.contact_consent_events
        (account_id, contact_id, kind, source, actor_user_id, detail)
      VALUES (new.account_id, new.id, 'restored', 'suppression', v_actor,
        jsonb_build_object('opted_out_at', CASE WHEN v_out THEN s.opted_out_at END,
                           'do_not_contact_at', CASE WHEN v_dnc THEN s.do_not_contact_at END,
                           'deleted_at', s.deleted_at, 'via', s.via, 'events', s.consent_events));
      v_out := v_out AND new.opted_out_at IS DISTINCT FROM s.opted_out_at;
      v_dnc := v_dnc AND new.do_not_contact_at IS DISTINCT FROM s.do_not_contact_at;
    END IF;
  END IF;

  IF new.marketing_opt_in_at IS DISTINCT FROM o_optin THEN
    INSERT INTO public.contact_consent_events
      (account_id, contact_id, kind, source, actor_user_id, detail)
    VALUES (new.account_id, new.id,
      CASE WHEN new.marketing_opt_in_at IS NULL
           THEN 'marketing_opt_in_withdrawn' ELSE 'marketing_opt_in' END,
      v_source, v_actor,
      jsonb_build_object('previous', o_optin, 'stamp', new.marketing_opt_in_at,
                         'opt_in_source', new.marketing_opt_in_source));
  END IF;
  IF v_out THEN
    INSERT INTO public.contact_consent_events
      (account_id, contact_id, kind, source, actor_user_id, detail)
    VALUES (new.account_id, new.id,
      CASE WHEN new.opted_out_at IS NULL THEN 'resubscribed' ELSE 'opted_out' END,
      v_source, v_actor,
      jsonb_build_object('previous', o_out, 'stamp', new.opted_out_at));
  END IF;
  IF v_dnc THEN
    INSERT INTO public.contact_consent_events
      (account_id, contact_id, kind, source, actor_user_id, detail)
    VALUES (new.account_id, new.id,
      CASE WHEN new.do_not_contact_at IS NULL
           THEN 'do_not_contact_cleared' ELSE 'do_not_contact_set' END,
      v_source, v_actor,
      jsonb_build_object('previous', o_dnc, 'stamp', new.do_not_contact_at,
                         'reason', new.do_not_contact_reason));
  END IF;
  RETURN NULL;
END
$log$
$create$;
END $guard$;
CREATE OR REPLACE TRIGGER contacts_consent_log
  AFTER INSERT OR UPDATE OF marketing_opt_in_at, opted_out_at, do_not_contact_at, phone
  ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_consent_log();

-- ---------- 3. Lifting ----------

CREATE OR REPLACE FUNCTION public.contacts_suppression_lift()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_hash bytea := public.contact_suppression_hash(OLD.account_id, OLD.phone);
  v_out  boolean := OLD.opted_out_at IS NOT NULL AND NEW.opted_out_at IS NULL;
  v_dnc  boolean := OLD.do_not_contact_at IS NOT NULL AND NEW.do_not_contact_at IS NULL;
BEGIN
  DELETE FROM public.contact_suppressions s
   WHERE s.account_id = OLD.account_id AND (s.phone_hash = v_hash OR s.contact_id = OLD.id)
     AND (v_out OR s.opted_out_at IS NULL) AND (v_dnc OR s.do_not_contact_at IS NULL);
  UPDATE public.contact_suppressions s
     SET opted_out_at = CASE WHEN NOT v_out THEN s.opted_out_at END,
         do_not_contact_at = CASE WHEN NOT v_dnc THEN s.do_not_contact_at END
   WHERE s.account_id = OLD.account_id AND (s.phone_hash = v_hash OR s.contact_id = OLD.id)
     -- The row above's complement, also against one kept meanwhile.
     AND NOT ((v_out OR s.opted_out_at IS NULL) AND (v_dnc OR s.do_not_contact_at IS NULL));
  RETURN NULL;
END;
$$;
CREATE OR REPLACE TRIGGER contacts_suppression_lift AFTER UPDATE OF opted_out_at, do_not_contact_at ON public.contacts
  FOR EACH ROW WHEN ((OLD.opted_out_at IS NOT NULL AND NEW.opted_out_at IS NULL)
                     OR (OLD.do_not_contact_at IS NOT NULL AND NEW.do_not_contact_at IS NULL))
  EXECUTE FUNCTION public.contacts_suppression_lift();

-- ---------- 4. Open work ----------

CREATE OR REPLACE FUNCTION public.contact_open_work(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'cases', (SELECT count(*) FROM public.cases k
               WHERE k.account_id = p_account AND k.closed_at IS NULL
                 AND (k.contact_id = p_contact
                      OR k.group_id IN (SELECT g.id FROM public.submission_groups g
                                         WHERE g.contact_id = p_contact AND g.account_id = p_account))),
    'deal_rooms', (SELECT count(*) FROM public.deal_rooms r
                    WHERE r.account_id = p_account AND r.contact_id = p_contact
                      AND r.status NOT IN ('closed', 'failed')),
    'submission_groups', (SELECT count(*) FROM public.submission_groups g
                           WHERE g.account_id = p_account AND g.contact_id = p_contact AND g.status = 'ACTIVE'))
$$;

CREATE OR REPLACE FUNCTION public.contacts_open_work_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  w jsonb;
BEGIN
  IF auth.uid() IS NULL OR coalesce(auth.role(), '') = 'service_role'
     OR NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = OLD.account_id) THEN
    RETURN OLD;
  END IF;
  w := public.contact_open_work(OLD.account_id, OLD.id);
  IF w <> '{"cases": 0, "deal_rooms": 0, "submission_groups": 0}'::jsonb THEN
    RAISE EXCEPTION 'this customer has open work and cannot be deleted (open cases: %, open deal rooms: %, active submission groups: %)',
      w ->> 'cases', w ->> 'deal_rooms', w ->> 'submission_groups'
      USING ERRCODE = 'ZC280', HINT = 'HAS_OPEN_WORK', DETAIL = w::text;
  END IF;
  RETURN OLD;
END;
$$;
CREATE OR REPLACE TRIGGER contacts_open_work_guard BEFORE DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_open_work_guard();

-- ---------- 5. What goes with them ----------

-- {contacts, chats, tasks, deal_rooms, deals, documents, cases, blocked:
-- [{contact_id, legal_hold, cases, deal_rooms, submission_groups}]}. Chats,
-- tasks and rooms are deleted; deals, documents and cases stay without
-- their customer. Contacts the caller may not delete are not counted.
CREATE OR REPLACE FUNCTION public.contact_delete_preview(p_contacts uuid[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH c AS MATERIALIZED (
    SELECT x.id, x.account_id FROM contacts x
     WHERE x.id = ANY (p_contacts[1:1000])
       AND x.account_id = (SELECT current_account_id())
       AND (SELECT current_role_rank()) >= 2
       AND ((SELECT current_role_rank()) >= 4 OR can_view_contact(x.account_id, x.id, x.user_id))),
  b AS (
    SELECT c.id, privacy_on_hold(c.account_id, c.id) AS held, contact_open_work(c.account_id, c.id) AS w FROM c)
  SELECT jsonb_build_object(
    'contacts', (SELECT count(*) FROM c),
    'chats', (SELECT count(*) FROM conversations v WHERE v.contact_id IN (SELECT id FROM c)),
    'tasks', (SELECT count(*) FROM tasks t WHERE t.contact_id IN (SELECT id FROM c) AND t.status = 'open'),
    'deal_rooms', (SELECT count(*) FROM deal_rooms r WHERE r.contact_id IN (SELECT id FROM c)),
    'deals', (SELECT count(*) FROM deals d WHERE d.contact_id IN (SELECT id FROM c)),
    'documents', (SELECT count(*) FROM customer_documents d WHERE d.contact_id IN (SELECT id FROM c)),
    'cases', (SELECT count(*) FROM cases k WHERE k.contact_id IN (SELECT id FROM c)),
    'blocked', (SELECT coalesce(jsonb_agg(b.w || jsonb_build_object('contact_id', b.id, 'legal_hold', b.held) ORDER BY b.id), '[]')
                  FROM b WHERE b.held OR b.w <> '{"cases": 0, "deal_rooms": 0, "submission_groups": 0}'::jsonb))
$$;

-- ---------- 6. PDPL ----------

CREATE OR REPLACE FUNCTION public.privacy_contact_suppressions_export(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(public.privacy_strip(to_jsonb(s) - 'phone_hash' - 'deleted_by' - 'contact_id')), '[]'::jsonb)
    FROM public.contacts c
    JOIN public.contact_suppressions s
      ON s.account_id = c.account_id
     AND (s.phone_hash = public.contact_suppression_hash(c.account_id, c.phone) OR s.contact_id = c.id)
   WHERE c.id = p_contact AND c.account_id = p_account
$$;

CREATE OR REPLACE FUNCTION public.privacy_contact_suppressions_erase(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_n integer;
BEGIN
  UPDATE public.contact_suppressions s SET via = 'erase', deleted_by = NULL, contact_id = NULL
    FROM public.contacts c
   WHERE c.id = p_contact AND c.account_id = p_account AND s.account_id = p_account
     AND (s.phone_hash = public.contact_suppression_hash(c.account_id, c.phone) OR s.contact_id = c.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('counts', jsonb_build_object('contact_suppressions', v_n), 'objects', '[]'::jsonb);
END;
$$;

INSERT INTO public.privacy_extensions (name, export_fn, erase_fn, added_in)
VALUES ('contact_suppressions', 'privacy_contact_suppressions_export', 'privacy_contact_suppressions_erase', '280')
ON CONFLICT (name) DO UPDATE SET export_fn = excluded.export_fn, erase_fn = excluded.erase_fn;

-- ---------- Privileges ----------

REVOKE ALL ON FUNCTION public.contact_suppression_number(text), public.contact_suppression_hash(uuid, text),
  public.contacts_suppression_keep(), public.contacts_suppression_restore(), public.contacts_suppression_lift(),
  public.contacts_consent_log(), public.contact_open_work(uuid, uuid), public.contacts_open_work_guard(),
  public.contact_delete_preview(uuid[]), public.privacy_contact_suppressions_export(uuid, uuid),
  public.privacy_contact_suppressions_erase(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.contact_delete_preview(uuid[]) TO authenticated;

RESET lock_timeout;
