-- ============================================================
-- 315_webhook_keys.sql — a webhook stops with the API key that made it,
-- an erased customer leaves the webhook queue, and the web form loses no
-- text and makes no twin.
--
--  1. webhook_endpoints.api_key_id: the key that made (or last changed) the
--     endpoint; NULL = before 315, or the key was deleted. Revoking or
--     deleting a key switches its endpoints off (is_active, as 293) and
--     rings the live owners and admins (webhook_disabled). An endpoint of a
--     revoked key is not switched on again until a live key takes it over.
--  2. privacy_webhook_outbox_erase: an erasure deletes the queued and
--     delivered webhook_event_outbox rows that name the contact or one of
--     its chats (privacy_extensions); the export lists them.
--  3. web_form_submit (RESTATES 275's): a text sent after the task of the
--     last 10 minutes was closed opens a new task.
--  4. web_form_submit: a customer stored in another form of the same number
--     ("0501234567") is found, not made twice (web_form_stored_forms mirrors
--     storedForms in src/lib/contacts/phone-match.ts: change both).
--
-- Re-running 249, 256 or 275 puts an older web_form_submit back: re-run 315.
-- Apply before the build, as a superuser or BYPASSRLS role. Additive for the
-- previous build. Re-runnable. verify-webhook-keys.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '315 must be applied by a superuser or BYPASSRLS role';
  END IF;
  IF to_regclass('public.privacy_extensions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute
                     WHERE attrelid = 'public.webhook_endpoints'::regclass AND attname = 'first_failure_at')
     OR to_regprocedure('public.web_form_submit(text, text, text, text, text, jsonb)') IS NULL THEN
    RAISE EXCEPTION '315: apply 229, 249 and 293 first';
  END IF;
END $$;

-- ---------- 1: the key an endpoint belongs to ----------

ALTER TABLE public.webhook_endpoints ADD COLUMN IF NOT EXISTS api_key_id uuid NULL
  REFERENCES public.api_keys(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS webhook_endpoints_api_key_idx
  ON public.webhook_endpoints (api_key_id) WHERE api_key_id IS NOT NULL;
COMMENT ON COLUMN public.webhook_endpoints.api_key_id IS
  'The API key that made or last changed the endpoint; revoking or deleting it switches the endpoint off. NULL = made before 315, or the key is gone. Migration 315.';

-- A key switched off takes its endpoints with it. The SET NULL alone would
-- leave them sending. Every endpoint of the key is locked, on or off, so one
-- being switched on at the same moment is seen. The bell never stops it.
CREATE OR REPLACE FUNCTION public.api_key_webhooks_off()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  e public.webhook_endpoints%ROWTYPE;
BEGIN
  FOR e IN SELECT * FROM public.webhook_endpoints w WHERE w.api_key_id = OLD.id ORDER BY w.id FOR UPDATE LOOP
    CONTINUE WHEN NOT e.is_active;
    UPDATE public.webhook_endpoints w SET is_active = false WHERE w.id = e.id;
    BEGIN
      INSERT INTO public.notifications (account_id, user_id, type, title, body, meta)
      SELECT DISTINCT e.account_id, p.user_id, 'webhook_disabled', 'A webhook was switched off',
             coalesce(substring(e.url FROM '^https?://(?:[^/?#@]*@)?([^/?#]+)'), 'The receiver')
               || ' gets no more events: the API key "' || left(OLD.name, 80) || '" that set it up was '
               || CASE WHEN TG_OP = 'DELETE' THEN 'deleted' ELSE 'revoked' END
               || '. If the receiver is still needed, set it up again with a live key.',
             jsonb_build_object('endpoint_id', e.id)
        FROM public.profiles p
        JOIN public.accounts a ON a.id = p.account_id
       WHERE p.account_id = e.account_id AND p.deactivated_at IS NULL AND p.account_role IN ('owner', 'admin');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'webhook_disabled bell for endpoint % not rung: % (%)', e.id, SQLERRM, SQLSTATE;
    END;
  END LOOP;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.api_key_webhooks_off() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS api_keys_webhooks_off ON public.api_keys;
CREATE TRIGGER api_keys_webhooks_off
  AFTER UPDATE OF revoked_at ON public.api_keys
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION public.api_key_webhooks_off();
DROP TRIGGER IF EXISTS api_keys_webhooks_off_delete ON public.api_keys;
CREATE TRIGGER api_keys_webhooks_off_delete
  BEFORE DELETE ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.api_key_webhooks_off();

-- The other side: an endpoint whose key is revoked stays off. A key newly
-- named is share-locked, so a revoke running now waits and then sees the
-- row; an unchanged key is only read (the revoke locks the endpoint itself).
-- A key of another workspace is not recorded.
CREATE OR REPLACE FUNCTION public.webhook_endpoint_key()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account uuid;
  v_revoked timestamptz;
BEGIN
  IF NEW.api_key_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.api_key_id IS NOT DISTINCT FROM OLD.api_key_id THEN
    IF NOT NEW.is_active OR OLD.is_active THEN
      RETURN NEW;
    END IF;
    SELECT k.account_id, k.revoked_at INTO v_account, v_revoked
      FROM public.api_keys k WHERE k.id = NEW.api_key_id;
  ELSE
    SELECT k.account_id, k.revoked_at INTO v_account, v_revoked
      FROM public.api_keys k WHERE k.id = NEW.api_key_id FOR SHARE;
  END IF;
  IF v_account IS DISTINCT FROM NEW.account_id THEN
    NEW.api_key_id := NULL;
  ELSIF v_revoked IS NOT NULL THEN
    NEW.is_active := false;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.webhook_endpoint_key() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS webhook_endpoints_key ON public.webhook_endpoints;
CREATE TRIGGER webhook_endpoints_key
  BEFORE INSERT OR UPDATE OF is_active, api_key_id ON public.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION public.webhook_endpoint_key();

-- ---------- 2: an erased customer leaves the queue ----------

CREATE OR REPLACE FUNCTION public.privacy_webhook_outbox_erase(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM public.webhook_event_outbox o
   WHERE o.account_id = p_account
     AND (o.payload ->> 'contact_id' = p_contact::text
          OR o.payload ->> 'conversation_id' IN (
               SELECT c.id::text FROM public.conversations c
                WHERE c.account_id = p_account AND c.contact_id = p_contact));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('counts', jsonb_build_object('webhook_event_outbox', v_n), 'objects', '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.privacy_webhook_outbox_erase(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.privacy_webhook_outbox_export(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'event', o.event, 'payload', o.payload, 'created_at', o.created_at,
           'delivered_at', o.delivered_at) ORDER BY o.id), '[]'::jsonb)
    FROM public.webhook_event_outbox o
   WHERE o.account_id = p_account
     AND (o.payload ->> 'contact_id' = p_contact::text
          OR o.payload ->> 'conversation_id' IN (
               SELECT c.id::text FROM public.conversations c
                WHERE c.account_id = p_account AND c.contact_id = p_contact))
$$;

REVOKE ALL ON FUNCTION public.privacy_webhook_outbox_export(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.privacy_extensions (name, export_fn, erase_fn, added_in)
VALUES ('webhook_event_outbox', 'privacy_webhook_outbox_export', 'privacy_webhook_outbox_erase', '315')
ON CONFLICT (name) DO UPDATE SET export_fn = excluded.export_fn, erase_fn = excluded.erase_fn;

-- ---------- 4: the forms one number may be stored in ----------

-- storedForms (src/lib/contacts/phone-match.ts): a 971 number may sit with a
-- trunk 0, without its country code, or with "00". Any other country gives
-- its exact form: a local "05..." could as well be Saudi.
CREATE OR REPLACE FUNCTION public.web_form_stored_forms(p_digits text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN p_digits LIKE '971%' THEN
    ARRAY[p_digits, '00' || p_digits, '9710' || substr(p_digits, 4), '009710' || substr(p_digits, 4)]
    || CASE WHEN length(p_digits) IN (11, 12)
            THEN ARRAY['0' || substr(p_digits, 4), substr(p_digits, 4)] ELSE '{}'::text[] END
  ELSE ARRAY[p_digits] END
$$;

REVOKE ALL ON FUNCTION public.web_form_stored_forms(text) FROM PUBLIC, anon, authenticated, service_role;

-- The one contact stored in another form of the number. None when a second
-- row could be it too: another form, or a local number with the same last 8
-- digits (findExistingContact passes over those as well).
CREATE OR REPLACE FUNCTION public.web_form_contact_by_form(p_account uuid, p_phone text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE WHEN count(*) = 1 AND bool_and(m.same_line) THEN (array_agg(m.id))[1] END
    FROM (SELECT c.id, c.phone_normalized = ANY (public.web_form_stored_forms(p_phone)) AS same_line
            FROM public.contacts c
           WHERE c.account_id = p_account
             AND c.phone NOT LIKE 'erased-%'
             AND c.phone_normalized LIKE '%' || right(p_phone, 8)
             AND (c.phone_normalized = ANY (public.web_form_stored_forms(p_phone))
                  OR c.phone_normalized ~ '^0[1-9]' OR length(c.phone_normalized) <= 9)) m
$$;

REVOKE ALL ON FUNCTION public.web_form_contact_by_form(uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- ---------- 3 and 4: the form itself ----------

CREATE OR REPLACE FUNCTION public.web_form_submit(p_token text, p_name text, p_phone text, p_email text, p_message text, p_meta jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_acct    uuid;
  v_owner   uuid;
  v_name    text := nullif(left(regexp_replace(coalesce(p_name, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), 120), '');
  v_email   text := lower(nullif(left(btrim(coalesce(p_email, '')), 254), ''));
  v_message text := nullif(left(regexp_replace(coalesce(p_message, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), 2000), '');
  v_page    text;
  v_contact uuid;
  v_created boolean := false;
  v_task    boolean := false;
  v_detail  jsonb;
  v_note    text := v_message;
  v_meta    jsonb := '{}'::jsonb;
  v_open    uuid;
  v_old     text;
  v_add     text;
BEGIN
  SELECT w.account_id, a.owner_user_id INTO v_acct, v_owner
    FROM public.web_lead_forms w
    JOIN public.accounts a ON a.id = w.account_id
   WHERE p_token ~ '^[0-9a-f]{64}$'
     AND w.token = p_token
     AND w.enabled
     AND a.archived_at IS NULL;
  IF v_acct IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF p_phone IS NULL OR p_phone !~ '^[1-9][0-9]{9,14}$' THEN
    RAISE EXCEPTION 'The phone number must be international digits'
      USING ERRCODE = '22023', HINT = 'bad_phone';
  END IF;
  IF v_email IS NOT NULL AND v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    v_email := NULL;
  END IF;
  IF p_meta IS NOT NULL AND jsonb_typeof(p_meta) = 'object'
     AND jsonb_typeof(p_meta -> 'page_url') = 'string' THEN
    v_page := nullif(left(p_meta ->> 'page_url', 500), '');
  END IF;
  v_detail := jsonb_build_object('form', 'web', 'submitted_at', now())
    || CASE WHEN v_page IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('page_url', v_page) END;

  -- One submission per (workspace, number) at a time: the dedupe
  -- window below and the find-or-create are decided under this lock.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('web_form_submit'),
    pg_catalog.hashtext(v_acct::text || ':' || p_phone));

  SELECT c.id INTO v_contact
    FROM public.contacts c
   WHERE c.account_id = v_acct AND c.phone_normalized = p_phone
   LIMIT 1;

  IF v_contact IS NULL THEN
    -- 315: the same line stored another way ("050 123 4567"), as the
    -- WhatsApp side finds it; two that could be it are two guesses.
    v_contact := public.web_form_contact_by_form(v_acct, p_phone);
  END IF;

  IF v_contact IS NULL THEN
    INSERT INTO public.contacts (account_id, user_id, phone, name, email)
    VALUES (v_acct, v_owner, p_phone, v_name, v_email)
    ON CONFLICT (account_id, phone_normalized) WHERE phone_normalized <> ''
    DO NOTHING
    RETURNING id INTO v_contact;
    IF v_contact IS NOT NULL THEN
      v_created := true;
    ELSE
      -- An inbound message created it meanwhile.
      SELECT c.id INTO v_contact
        FROM public.contacts c
       WHERE c.account_id = v_acct AND c.phone_normalized = p_phone
       LIMIT 1;
    END IF;
  END IF;

  IF NOT v_created THEN
    -- An existing contact is never renamed by a public form (256): what
    -- was submitted goes in the task below for a person to judge.
    v_note := concat_ws(E'\n', v_message,
                        'Submitted name: ' || v_name,
                        'Submitted email: ' || v_email);
    v_meta := jsonb_strip_nulls(jsonb_build_object('submitted_name', v_name,
                                                   'submitted_email', v_email));
  END IF;

  PERFORM public.contact_set_lead_source_if_empty(v_acct, v_contact, 'web_form', v_detail);

  -- At most one OPEN "New web lead" task per contact per 10 minutes: a
  -- double click, a refresh or a bot repeating itself opens nothing new.
  -- 315: a task closed within the window takes nothing more, so what the
  -- visitor wrote after it gets a task of its own.
  -- 275: the visitor is told "ok", so what they wrote must be kept: a text
  -- the open task does not hold yet joins its note (4000 characters in all,
  -- 085's limit). A name or email is repeated only where it is not the
  -- contact's own, so a double click of a brand new lead adds nothing.
  SELECT nullif(concat_ws(E'\n', v_message,
           'Submitted name: ' || CASE WHEN v_name IS DISTINCT FROM c.name THEN v_name END,
           'Submitted email: ' || CASE WHEN v_email IS DISTINCT FROM c.email THEN v_email END), '')
    INTO v_add
    FROM public.contacts c WHERE c.id = v_contact;
  SELECT t.id, coalesce(t.note, '') INTO v_open, v_old
    FROM public.tasks t
   WHERE t.contact_id = v_contact
     AND t.account_id = v_acct
     AND t.source = 'automation'
     AND t.source_ref LIKE 'web_form:%'
     AND t.status = 'open'
     AND t.created_at > now() - interval '10 minutes'
   ORDER BY t.created_at DESC, t.id DESC
   LIMIT 1
     FOR UPDATE;
  IF NOT FOUND THEN
    -- Nor does the same submission again after its task was closed.
    INSERT INTO public.tasks
           (account_id, kind, title, note, contact_id, source, source_ref, meta)
    SELECT v_acct, 'follow_up', 'New web lead', v_note, v_contact,
           'automation',
           'web_form:' || v_contact::text || ':'
             || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text,
           jsonb_build_object('web_form', true)
             || CASE WHEN v_page IS NULL THEN '{}'::jsonb
                     ELSE jsonb_build_object('page_url', v_page) END
             || v_meta
     WHERE NOT EXISTS (
             SELECT 1 FROM public.tasks t
              WHERE t.contact_id = v_contact
                AND t.account_id = v_acct
                AND t.source = 'automation'
                AND t.source_ref LIKE 'web_form:%'
                AND t.created_at > now() - interval '10 minutes'
                AND (v_add IS NULL
                     OR strpos(E'\n\n' || coalesce(t.note, '') || E'\n\n', E'\n\n' || v_add || E'\n\n') > 0
                     OR strpos(E'\n\n' || coalesce(t.note, '') || E'\n\n', E'\n\n' || v_note || E'\n\n') > 0))
    ON CONFLICT (account_id, source, source_ref) DO NOTHING;
    v_task := FOUND;
  ELSIF v_note IS NOT NULL THEN
    IF v_add IS NOT NULL
       AND strpos(E'\n\n' || v_old || E'\n\n', E'\n\n' || v_add || E'\n\n') = 0
       AND strpos(E'\n\n' || v_old || E'\n\n', E'\n\n' || v_note || E'\n\n') = 0 THEN
      UPDATE public.tasks t
         SET note = left(CASE WHEN v_old = '' THEN v_add
                              ELSE v_old || E'\n\n' || v_add END, 4000)
       WHERE t.id = v_open;
    END IF;
  END IF;

  RETURN jsonb_build_object('status', 'ok', 'contact_id', v_contact,
    'contact_created', v_created, 'task_created', v_task);
END;
$function$;

REVOKE ALL ON FUNCTION public.web_form_submit(text, text, text, text, text, jsonb)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_form_submit(text, text, text, text, text, jsonb) TO service_role;

RESET lock_timeout;

NOTIFY pgrst, 'reload schema';
