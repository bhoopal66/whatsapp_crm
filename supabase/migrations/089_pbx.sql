-- 089_pbx.sql — phone system (Yeastar P-Series, module 015), database layer
--
-- What the event processor, the Yeastar routes and the call screens
-- build on. The API client and the event parser (src/lib/pbx/) talk to
-- the PBX; everything they learn lands here.
--
-- Tenancy. A PBX connection is configured by one workspace
-- (pbx_connections.account_id) but may serve several: pbx_did_routes
-- routes each dialled number (DID) to a workspace, and every extension,
-- call, live call and presence row carries the account it belongs to.
-- One person holds at most one extension per workspace, and only an
-- active staff member (owner/admin/team_leader/agent — named positively,
-- so a later non-staff role is excluded without a change here) can be
-- mapped (pbx_extensions_guard).
--
-- Secrets (C-6). Credentials, the webhook secret and the shared token
-- caches live in pbx_connection_secrets: application-encrypted strings,
-- RLS on with no policy and no client grant, so only the service role
-- reads them. Yeastar allows 8 live tokens per API application, so a
-- token is cached per connection and credential pair ('api' for the API
-- application, 'sdk' for the Linkus SDK AccessID/AccessKey, which needs
-- its own — token.ts). pbx_token_lock takes a transaction-scoped
-- advisory lock (it spans a transaction on a direct connection; one
-- PostgREST call is one transaction) and pbx_token_swap is the
-- compare-and-set write that holds across processes either way. Its
-- stamp is whole milliseconds and strictly increasing, so a value that
-- went through a JS Date compares equal.
--
-- Visibility. pbx_can_view_call() is the calls SELECT policy: the call
-- is in the caller's ACTIVE account and they rank team_leader or above,
-- were a party to it (user_id / peer_user_id — an internal call's two
-- extensions' people), or can see its contact (can_view_contact, 072).
-- A bank guest has no current_account_id() and sees nothing here. The
-- screen pop (call_live) shows a person only the calls ringing them or
-- answered by them; leaders and up see all. Writes are the service role
-- (the processor), except three SECURITY DEFINER functions that
-- re-check the caller: pbx_set_disposition, pbx_link_call_contact and
-- pbx_erase_contact_calls (pbx_my_extension reads the caller's mapping;
-- click-to-call from that extension only is C-7, checked by the route).
--
-- Recordings (C-1, C-8). Audio is in the PRIVATE bucket call-recordings
-- (account-<id>/…) with no client storage policy: playback is a server
-- route that writes call_access_log and then signs a 5-minute URL. The
-- log refuses a row unless the recording is playable
-- (pbx_recording_playable: fetched, not erased, and the English+Arabic
-- announcement confirmed played unless the workspace turned that
-- requirement off), so held audio cannot be served by a route that logs
-- first. The log and pbx_audit are append-only.
--
-- Erasure (C-3). pbx_erase_contact_calls (owner only) deletes the
-- contact's recording rows and returns their storage paths for the
-- route to delete, clears notes and disposition, and marks the calls
-- erased; time, duration, extension and direction stay. An erased call
-- stays erased and cannot take notes, a disposition or a recording
-- again (calls_erased_check, calls_guard, call_recordings_guard). A
-- recording under legal hold blocks the erasure.
--
-- pbx_purge() (service role, from a cron) drops screen-pop rows older
-- than a day and processed raw events older than 30 days. Retention of
-- recordings (pbx_settings.retention_days) is an open legal decision:
-- NULL keeps them, and nothing here deletes audio on a timer.
--
-- Re-runnable: CREATE … IF NOT EXISTS, CREATE OR REPLACE, DROP … IF
-- EXISTS, ON CONFLICT.

SET lock_timeout = '5s';

-- ---------- 1. Connections and their secrets ----------
CREATE TABLE IF NOT EXISTS public.pbx_connections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  label              text NOT NULL CHECK (btrim(label) <> '' AND char_length(label) <= 100),
  edition            text NOT NULL CHECK (edition IN ('cloud', 'software', 'appliance')),
  base_url           text NOT NULL CHECK (btrim(base_url) <> ''),
  api_path           text NOT NULL DEFAULT 'openapi/v1.0',
  client_id_last4    text NULL CHECK (char_length(client_id_last4) <= 4),
  firmware           text NULL,
  status             text NOT NULL DEFAULT 'unknown'
                     CHECK (status IN ('unknown', 'connected', 'disconnected', 'auth_failed')),
  last_event_at      timestamptz NULL,
  last_error         text NULL,
  -- The secret part of the callback URL: 64 hex characters from two
  -- v4 UUIDs (pg_strong_random), no extension needed.
  webhook_path_token text NOT NULL UNIQUE
                     DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
                     CHECK (char_length(webhook_path_token) >= 32),
  created_by         uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pbx_connections_account_idx ON public.pbx_connections (account_id);

CREATE TABLE IF NOT EXISTS public.pbx_connection_secrets (
  connection_id              uuid PRIMARY KEY REFERENCES public.pbx_connections(id) ON DELETE CASCADE,
  client_id_enc              text NULL,
  client_secret_enc          text NULL,
  sdk_access_id_enc          text NULL,
  sdk_access_key_enc         text NULL,
  webhook_secret_enc         text NULL,
  token_cache_enc            text NULL,
  token_cache_updated_at     timestamptz NULL,
  sdk_token_cache_enc        text NULL,
  sdk_token_cache_updated_at timestamptz NULL,
  backoff_until              timestamptz NULL,
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.pbx_connection_secrets IS
  'PBX credentials and token caches, AES-GCM encrypted by the app. Service role only (RLS on, no policy, no client grant). Migration 089.';

-- Serialises minting for one connection and credential pair until the
-- calling transaction ends.
CREATE OR REPLACE FUNCTION public.pbx_token_lock(p_connection_id uuid, p_kind text DEFAULT 'api')
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('api', 'sdk') THEN
    RAISE EXCEPTION 'Unknown token kind %', p_kind USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pbx_token:' || p_connection_id::text || ':' || p_kind, 0));
END;
$$;

-- Writes the token cache only if it still carries the stamp the caller
-- read (NULL = never written). True when written.
CREATE OR REPLACE FUNCTION public.pbx_token_swap(
  p_connection_id uuid,
  p_expected_updated_at timestamptz,
  p_new_enc text,
  p_kind text DEFAULT 'api'
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_kind = 'api' THEN
    UPDATE pbx_connection_secrets
       SET token_cache_enc = p_new_enc,
           token_cache_updated_at = GREATEST(date_trunc('milliseconds', clock_timestamp()),
                                             token_cache_updated_at + interval '1 millisecond'),
           updated_at = now()
     WHERE connection_id = p_connection_id
       AND token_cache_updated_at IS NOT DISTINCT FROM p_expected_updated_at;
  ELSIF p_kind = 'sdk' THEN
    UPDATE pbx_connection_secrets
       SET sdk_token_cache_enc = p_new_enc,
           sdk_token_cache_updated_at = GREATEST(date_trunc('milliseconds', clock_timestamp()),
                                                 sdk_token_cache_updated_at + interval '1 millisecond'),
           updated_at = now()
     WHERE connection_id = p_connection_id
       AND sdk_token_cache_updated_at IS NOT DISTINCT FROM p_expected_updated_at;
  ELSE
    RAISE EXCEPTION 'Unknown token kind %', p_kind USING ERRCODE = '22023';
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END;
$$;

-- ---------- 2. Numbers and extensions ----------
CREATE TABLE IF NOT EXISTS public.pbx_did_routes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.pbx_connections(id) ON DELETE CASCADE,
  did_number    text NOT NULL CHECK (did_number ~ '^[0-9]{1,20}$'),
  name_on_pbx   text NULL,
  account_id    uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pbx_did_routes_number_key UNIQUE (connection_id, did_number)
);
CREATE INDEX IF NOT EXISTS pbx_did_routes_account_idx ON public.pbx_did_routes (account_id);

CREATE TABLE IF NOT EXISTS public.pbx_extensions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id      uuid NOT NULL REFERENCES public.pbx_connections(id) ON DELETE CASCADE,
  extension          text NOT NULL CHECK (btrim(extension) <> '' AND char_length(extension) <= 32),
  account_id         uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id            uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  softphone_enabled  boolean NOT NULL DEFAULT false,
  presence_monitor   boolean NOT NULL DEFAULT true,
  registration_state text NULL,
  client_kind        text NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pbx_extensions_extension_key UNIQUE (connection_id, extension)
);
-- One extension per person per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS pbx_extensions_one_per_person
  ON public.pbx_extensions (account_id, user_id) WHERE user_id IS NOT NULL;

-- The mapped person is an active staff member of the extension's
-- account. Checked when the mapping changes, so a person deactivated
-- later does not block the processor's registration updates.
CREATE OR REPLACE FUNCTION public.pbx_extensions_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.user_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.user_id IS DISTINCT FROM OLD.user_id
          OR NEW.account_id IS DISTINCT FROM OLD.account_id)
     AND NOT EXISTS (SELECT 1 FROM profiles p
                      WHERE p.user_id = NEW.user_id
                        AND p.account_id = NEW.account_id
                        AND p.deactivated_at IS NULL
                        AND p.account_role IN ('owner', 'admin', 'team_leader', 'agent')) THEN
    RAISE EXCEPTION 'An extension can only be mapped to an active staff member of its workspace'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS pbx_extensions_guard ON public.pbx_extensions;
CREATE TRIGGER pbx_extensions_guard
  BEFORE INSERT OR UPDATE ON public.pbx_extensions
  FOR EACH ROW EXECUTE FUNCTION public.pbx_extensions_guard();

-- ---------- 3. Calls ----------
CREATE TABLE IF NOT EXISTS public.calls (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- SET NULL: removing a PBX keeps the call history.
  connection_id       uuid NULL REFERENCES public.pbx_connections(id) ON DELETE SET NULL,
  pbx_call_id         text NOT NULL CHECK (btrim(pbx_call_id) <> ''),
  pbx_uid             text NULL,
  direction           text NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal')),
  remote_number       text NULL,
  extension           text NULL,
  -- Our party (the extension's person) and, on an internal call or a
  -- transfer, the other one.
  user_id             uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  peer_user_id        uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  contact_id          uuid NULL,
  conversation_id     uuid NULL,
  deal_id             uuid NULL REFERENCES public.deals(id) ON DELETE SET NULL,
  did_number          text NULL,
  status              text NOT NULL DEFAULT 'ringing'
                      CHECK (status IN ('ringing', 'in_progress', 'answered', 'no_answer', 'busy',
                                        'voicemail', 'abandoned', 'failed')),
  started_at          timestamptz NOT NULL DEFAULT now(),
  answered_at         timestamptz NULL,
  ended_at            timestamptz NULL,
  ring_seconds        integer NULL CHECK (ring_seconds >= 0),
  talk_seconds        integer NULL CHECK (talk_seconds >= 0),
  disposition         text NULL
                      CHECK (disposition IN ('interested', 'docs_requested', 'call_back',
                                             'not_eligible', 'wrong_number')),
  notes               text NULL CHECK (char_length(notes) <= 4000),
  notes_updated_by    uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  notes_updated_at    timestamptz NULL,
  recording_state     text NOT NULL DEFAULT 'none'
                      CHECK (recording_state IN ('none', 'pending', 'fetched', 'held', 'failed', 'erased')),
  announcement_played boolean NOT NULL DEFAULT false,
  erased_at           timestamptz NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calls_pbx_call_key UNIQUE (connection_id, pbx_call_id),
  CONSTRAINT calls_id_account_key UNIQUE (id, account_id),
  CONSTRAINT calls_contact_fkey FOREIGN KEY (contact_id, account_id)
    REFERENCES public.contacts (id, account_id) ON DELETE SET NULL (contact_id),
  CONSTRAINT calls_conversation_fkey FOREIGN KEY (conversation_id, account_id)
    REFERENCES public.conversations (id, account_id) ON DELETE SET NULL (conversation_id),
  CONSTRAINT calls_internal_no_contact CHECK (direction <> 'internal' OR contact_id IS NULL),
  CONSTRAINT calls_erased_check CHECK (
    (recording_state = 'erased') = (erased_at IS NOT NULL)
    AND (erased_at IS NULL OR (notes IS NULL AND disposition IS NULL)))
);
-- The contact timeline, "calls this month", "my calls".
-- Filled by the event processor (src/lib/pbx/process.ts): the PBX's
-- recording file name, for the fetch while recording_state is
-- 'pending'; and meta: contact_candidates (a number that matched more
-- than one contact, for a person to pick) and unrouted (an inbound call
-- to a number with no pbx_did_routes row, filed under the connection's
-- own workspace). Appended to 089 before release; re-runnable.
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS recording_file text NULL;
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS calls_contact_timeline_idx
  ON public.calls (contact_id, started_at DESC) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_account_started_idx ON public.calls (account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS calls_user_started_idx
  ON public.calls (user_id, started_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_peer_idx ON public.calls (peer_user_id) WHERE peer_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_conversation_idx ON public.calls (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_deal_idx ON public.calls (deal_id) WHERE deal_id IS NOT NULL;

-- Every writer, the service role included.
CREATE OR REPLACE FUNCTION public.calls_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.notes := NULLIF(btrim(NEW.notes), '');
  IF TG_OP = 'UPDATE' THEN
    -- connection_id may only lose its value (the FK's ON DELETE SET NULL).
    IF NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.pbx_call_id IS DISTINCT FROM OLD.pbx_call_id
       OR (NEW.connection_id IS DISTINCT FROM OLD.connection_id AND NEW.connection_id IS NOT NULL) THEN
      RAISE EXCEPTION 'A call''s account, connection and PBX id cannot be changed'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.erased_at IS NOT NULL AND NEW.erased_at IS DISTINCT FROM OLD.erased_at THEN
      RAISE EXCEPTION 'An erased call stays erased' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.deal_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.deal_id IS DISTINCT FROM OLD.deal_id)
     AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.id = NEW.deal_id AND d.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'The deal does not belong to this call''s account' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS calls_guard ON public.calls;
CREATE TRIGGER calls_guard
  BEFORE INSERT OR UPDATE ON public.calls
  FOR EACH ROW EXECUTE FUNCTION public.calls_guard();

-- ---------- 4. The screen pop ----------
CREATE TABLE IF NOT EXISTS public.call_live (
  connection_id    uuid NOT NULL REFERENCES public.pbx_connections(id) ON DELETE CASCADE,
  pbx_call_id      text NOT NULL,
  account_id       uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id       uuid NULL,
  remote_number    text NULL,
  did_number       text NULL,
  ringing_user_ids uuid[] NOT NULL DEFAULT '{}',
  answered_by      uuid NULL,
  members          jsonb NOT NULL DEFAULT '[]'::jsonb,
  state            text NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, pbx_call_id),
  CONSTRAINT call_live_contact_fkey FOREIGN KEY (contact_id, account_id)
    REFERENCES public.contacts (id, account_id) ON DELETE SET NULL (contact_id)
);
CREATE INDEX IF NOT EXISTS call_live_updated_idx ON public.call_live (updated_at);
CREATE INDEX IF NOT EXISTS call_live_account_idx ON public.call_live (account_id);

-- ---------- 5. Recordings and their access log ----------
CREATE TABLE IF NOT EXISTS public.call_recordings (
  call_id             uuid PRIMARY KEY,
  account_id          uuid NOT NULL,
  storage_path        text NOT NULL UNIQUE,
  sha256              text NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes               bigint NULL CHECK (bytes >= 0),
  format              text NULL,
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  announcement_played boolean NOT NULL DEFAULT false,
  legal_hold          boolean NOT NULL DEFAULT false,
  erased_at           timestamptz NULL,
  CONSTRAINT call_recordings_call_fkey FOREIGN KEY (call_id, account_id)
    REFERENCES public.calls (id, account_id) ON DELETE CASCADE,
  -- Objects live under the call's own account in call-recordings.
  CONSTRAINT call_recordings_path_check CHECK (storage_path LIKE 'account-' || account_id::text || '/%')
);
CREATE INDEX IF NOT EXISTS call_recordings_account_idx ON public.call_recordings (account_id);

CREATE OR REPLACE FUNCTION public.call_recordings_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM calls c WHERE c.id = NEW.call_id AND c.erased_at IS NOT NULL) THEN
    RAISE EXCEPTION 'This call''s recording was erased' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS call_recordings_guard ON public.call_recordings;
CREATE TRIGGER call_recordings_guard
  BEFORE INSERT OR UPDATE ON public.call_recordings
  FOR EACH ROW EXECUTE FUNCTION public.call_recordings_guard();

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('call-recordings', 'call-recordings', false, 209715200)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 209715200;
-- No storage.objects policy names this bucket: only the service role
-- (the playback route, the processor) reads or writes it.

CREATE TABLE IF NOT EXISTS public.call_access_log (
  id         bigserial PRIMARY KEY,
  call_id    uuid NOT NULL,
  account_id uuid NOT NULL,
  -- No FK: the log outlives the login.
  user_id    uuid NOT NULL,
  action     text NOT NULL CHECK (action IN ('play', 'download', 'attach')),
  at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_access_log_call_fkey FOREIGN KEY (call_id, account_id)
    REFERENCES public.calls (id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS call_access_log_call_idx ON public.call_access_log (call_id, at DESC);
CREATE INDEX IF NOT EXISTS call_access_log_account_idx ON public.call_access_log (account_id, at DESC);

CREATE TABLE IF NOT EXISTS public.pbx_audit (
  id          bigserial PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  actor_id    uuid NULL,
  action      text NOT NULL,
  contact_id  uuid NULL,
  call_ids    uuid[] NOT NULL DEFAULT '{}',
  reason      text NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pbx_audit_account_idx ON public.pbx_audit (account_id, at DESC);

CREATE OR REPLACE FUNCTION public.call_access_log_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT pbx_recording_playable(NEW.call_id) THEN
      RAISE EXCEPTION 'This recording is not playable (held, erased or not fetched)'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  -- The cascade from a deleted call or account is the only removal.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM calls WHERE id = OLD.call_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'call_access_log is append-only' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS call_access_log_guard ON public.call_access_log;
CREATE TRIGGER call_access_log_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.call_access_log
  FOR EACH ROW EXECUTE FUNCTION public.call_access_log_guard();

CREATE OR REPLACE FUNCTION public.pbx_audit_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'pbx_audit is append-only' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS pbx_audit_append_only ON public.pbx_audit;
CREATE TRIGGER pbx_audit_append_only
  BEFORE UPDATE OR DELETE ON public.pbx_audit
  FOR EACH ROW EXECUTE FUNCTION public.pbx_audit_append_only();

-- ---------- 6. Presence and raw events ----------
CREATE TABLE IF NOT EXISTS public.pbx_presence (
  connection_id uuid NOT NULL REFERENCES public.pbx_connections(id) ON DELETE CASCADE,
  extension     text NOT NULL,
  account_id    uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id       uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  presence      text NULL,
  call_state    text NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, extension)
);
CREATE INDEX IF NOT EXISTS pbx_presence_account_idx ON public.pbx_presence (account_id);

CREATE TABLE IF NOT EXISTS public.pbx_events_raw (
  id            bigserial PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES public.pbx_connections(id) ON DELETE CASCADE,
  event_type    integer NULL,
  payload       jsonb NOT NULL,
  hash          text NOT NULL UNIQUE,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz NULL,
  error         text NULL
);
CREATE INDEX IF NOT EXISTS pbx_events_raw_pending_idx
  ON public.pbx_events_raw (received_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS pbx_events_raw_processed_idx
  ON public.pbx_events_raw (processed_at) WHERE processed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS pbx_events_raw_connection_idx ON public.pbx_events_raw (connection_id);

-- ---------- 7. Settings and bank numbers ----------
CREATE TABLE IF NOT EXISTS public.pbx_settings (
  account_id                 uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  announcement_required      boolean NOT NULL DEFAULT true,
  exclude_bank_numbers       boolean NOT NULL DEFAULT true,
  -- An open legal decision: NULL keeps recordings.
  retention_days             integer NULL CHECK (retention_days BETWEEN 1 AND 3650),
  missed_call_due_minutes    integer NOT NULL DEFAULT 30 CHECK (missed_call_due_minutes BETWEEN 0 AND 10080),
  mandatory_disposition      boolean NOT NULL DEFAULT false,
  missed_call_whatsapp_draft boolean NOT NULL DEFAULT false,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE OR REPLACE FUNCTION public.pbx_settings_stamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  IF auth.uid() IS NOT NULL THEN
    NEW.updated_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS pbx_settings_stamp ON public.pbx_settings;
CREATE TRIGGER pbx_settings_stamp
  BEFORE INSERT OR UPDATE ON public.pbx_settings
  FOR EACH ROW EXECUTE FUNCTION public.pbx_settings_stamp();

-- Bank staff numbers: their calls can be kept unrecorded (bank DSA terms).
CREATE TABLE IF NOT EXISTS public.pbx_bank_numbers (
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  number     text NOT NULL CHECK (number ~ '^[0-9]{3,20}$'),
  bank_code  text NOT NULL CHECK (btrim(bank_code) <> '' AND char_length(bank_code) <= 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, number)
);

-- C-1: fetched, not erased, and the announcement confirmed played
-- unless the workspace switched the requirement off.
CREATE OR REPLACE FUNCTION public.pbx_recording_playable(p_call_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM calls c
      JOIN call_recordings r ON r.call_id = c.id
      LEFT JOIN pbx_settings s ON s.account_id = c.account_id
     WHERE c.id = p_call_id
       AND c.recording_state = 'fetched'
       AND c.erased_at IS NULL
       AND r.erased_at IS NULL
       AND (r.announcement_played OR NOT COALESCE(s.announcement_required, true)))
$$;

-- updated_at on the plain tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pbx_connections', 'pbx_connection_secrets', 'pbx_did_routes',
                           'call_live', 'pbx_presence']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON public.%I', t);
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()', t);
  END LOOP;
END $$;

-- ---------- 8. Who sees a call ----------
CREATE OR REPLACE FUNCTION public.pbx_can_view_call(p_call public.calls)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_call.account_id IS NULL OR p_call.account_id IS DISTINCT FROM current_account_id() THEN false
    WHEN current_role_rank() >= 3 THEN true
    WHEN COALESCE(p_call.user_id = auth.uid(), false)
      OR COALESCE(p_call.peer_user_id = auth.uid(), false) THEN true
    WHEN p_call.contact_id IS NOT NULL THEN EXISTS (
      SELECT 1 FROM contacts c
       WHERE c.id = p_call.contact_id
         AND can_view_contact(c.account_id, c.id, c.user_id))
    ELSE false
  END
$$;
COMMENT ON FUNCTION public.pbx_can_view_call(public.calls) IS
  'calls SELECT: the caller''s active account, and team leader or above, a party to the call, or able to see its contact (can_view_contact). Guests: nothing. Migration 089.';

-- ---------- 9. The people's functions ----------
CREATE OR REPLACE FUNCTION public.pbx_my_extension()
RETURNS TABLE (connection_id uuid, extension text, softphone_enabled boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT e.connection_id, e.extension, e.softphone_enabled
    FROM pbx_extensions e
   WHERE e.user_id = auth.uid()
     AND e.account_id = current_account_id()
     AND current_role_rank() >= 2
$$;

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
     AND NOT (COALESCE(v_call.user_id = auth.uid(), false) AND current_role_rank() >= 2) THEN
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

-- Re-link a mis-matched call to a contact the caller can see. The
-- chat follows the contact; a deal of another contact is dropped.
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

-- C-3, owner only. Returns the storage paths for the route to delete.
CREATE OR REPLACE FUNCTION public.pbx_erase_contact_calls(p_contact_id uuid, p_reason text)
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid := current_account_id();
  v_reason  text := NULLIF(btrim(p_reason), '');
  v_calls   uuid[];
  v_paths   text[];
BEGIN
  IF auth.uid() IS NULL OR v_account IS NULL OR current_role_rank() < 5 THEN
    RAISE EXCEPTION 'Only the workspace owner can erase call records' USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'A reason is required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM contacts WHERE id = p_contact_id AND account_id = v_account) THEN
    RAISE EXCEPTION 'Contact not found' USING ERRCODE = 'P0002';
  END IF;
  WITH locked AS (
    SELECT id, started_at FROM calls
     WHERE contact_id = p_contact_id AND account_id = v_account
     FOR UPDATE)
  SELECT COALESCE(array_agg(id ORDER BY started_at, id), '{}') INTO v_calls FROM locked;
  IF EXISTS (SELECT 1 FROM call_recordings WHERE call_id = ANY (v_calls) AND legal_hold) THEN
    RAISE EXCEPTION 'A recording of this contact is under legal hold' USING ERRCODE = '55000';
  END IF;
  WITH gone AS (DELETE FROM call_recordings WHERE call_id = ANY (v_calls) RETURNING storage_path)
  SELECT COALESCE(array_agg(storage_path ORDER BY storage_path), '{}') INTO v_paths FROM gone;
  UPDATE calls
     SET notes = NULL, disposition = NULL, notes_updated_by = NULL, notes_updated_at = NULL,
         recording_state = 'erased', erased_at = COALESCE(erased_at, now())
   WHERE id = ANY (v_calls);
  INSERT INTO pbx_audit (account_id, actor_id, action, contact_id, call_ids, reason, detail)
  VALUES (v_account, auth.uid(), 'erase_contact_calls', p_contact_id, v_calls, v_reason,
          jsonb_build_object('recordings', COALESCE(array_length(v_paths, 1), 0)));
  RETURN v_paths;
END;
$$;

-- Service role, from a cron.
CREATE OR REPLACE FUNCTION public.pbx_purge()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_live   integer;
  v_events integer;
BEGIN
  DELETE FROM call_live WHERE updated_at < now() - interval '1 day';
  GET DIAGNOSTICS v_live = ROW_COUNT;
  DELETE FROM pbx_events_raw WHERE processed_at < now() - interval '30 days';
  GET DIAGNOSTICS v_events = ROW_COUNT;
  RETURN jsonb_build_object('call_live', v_live, 'events', v_events);
END;
$$;

-- ---------- 10. Row-level security ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pbx_connections', 'pbx_connection_secrets', 'pbx_did_routes', 'pbx_extensions',
                           'calls', 'call_live', 'call_recordings', 'call_access_log', 'pbx_audit',
                           'pbx_presence', 'pbx_events_raw', 'pbx_settings', 'pbx_bank_numbers']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS pbx_connections_select ON public.pbx_connections;
CREATE POLICY pbx_connections_select ON public.pbx_connections
  FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id()) AND (SELECT public.current_role_rank()) >= 4);

DROP POLICY IF EXISTS pbx_did_routes_select ON public.pbx_did_routes;
CREATE POLICY pbx_did_routes_select ON public.pbx_did_routes
  FOR SELECT TO authenticated USING (account_id = (SELECT public.current_account_id()));

DROP POLICY IF EXISTS pbx_extensions_select ON public.pbx_extensions;
CREATE POLICY pbx_extensions_select ON public.pbx_extensions
  FOR SELECT TO authenticated USING (account_id = (SELECT public.current_account_id()));

DROP POLICY IF EXISTS pbx_presence_select ON public.pbx_presence;
CREATE POLICY pbx_presence_select ON public.pbx_presence
  FOR SELECT TO authenticated USING (account_id = (SELECT public.current_account_id()));

DROP POLICY IF EXISTS calls_select ON public.calls;
CREATE POLICY calls_select ON public.calls
  FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id()) AND public.pbx_can_view_call(calls));

DROP POLICY IF EXISTS call_live_select ON public.call_live;
CREATE POLICY call_live_select ON public.call_live
  FOR SELECT TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND ((SELECT auth.uid()) = ANY (ringing_user_ids)
         OR answered_by = (SELECT auth.uid())
         OR (SELECT public.current_role_rank()) >= 3)
  );

-- Metadata only (the audio has no client policy): whoever sees the call.
DROP POLICY IF EXISTS call_recordings_select ON public.call_recordings;
CREATE POLICY call_recordings_select ON public.call_recordings
  FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND EXISTS (SELECT 1 FROM public.calls c WHERE c.id = call_recordings.call_id));

DROP POLICY IF EXISTS call_access_log_select ON public.call_access_log;
CREATE POLICY call_access_log_select ON public.call_access_log
  FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id()) AND (SELECT public.current_role_rank()) >= 4);

DROP POLICY IF EXISTS pbx_audit_select ON public.pbx_audit;
CREATE POLICY pbx_audit_select ON public.pbx_audit
  FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id()) AND (SELECT public.current_role_rank()) >= 4);

DROP POLICY IF EXISTS pbx_settings_select ON public.pbx_settings;
CREATE POLICY pbx_settings_select ON public.pbx_settings
  FOR SELECT TO authenticated USING (account_id = (SELECT public.current_account_id()));
DROP POLICY IF EXISTS pbx_settings_insert ON public.pbx_settings;
CREATE POLICY pbx_settings_insert ON public.pbx_settings
  FOR INSERT TO authenticated
  WITH CHECK (account_id = (SELECT public.current_account_id()) AND (SELECT public.current_role_rank()) >= 4);
DROP POLICY IF EXISTS pbx_settings_update ON public.pbx_settings;
CREATE POLICY pbx_settings_update ON public.pbx_settings
  FOR UPDATE TO authenticated
  USING (account_id = (SELECT public.current_account_id()) AND (SELECT public.current_role_rank()) >= 4)
  WITH CHECK (account_id = (SELECT public.current_account_id()) AND (SELECT public.current_role_rank()) >= 4);

DROP POLICY IF EXISTS pbx_bank_numbers_admin ON public.pbx_bank_numbers;
CREATE POLICY pbx_bank_numbers_admin ON public.pbx_bank_numbers
  FOR ALL TO authenticated
  USING (account_id = (SELECT public.current_account_id()) AND (SELECT public.current_role_rank()) >= 4)
  WITH CHECK (account_id = (SELECT public.current_account_id()) AND (SELECT public.current_role_rank()) >= 4);

-- ---------- 11. Realtime ----------
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['call_live', 'pbx_presence', 'calls']
    LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END $$;

-- ---------- 12. Privileges ----------
-- Supabase grants ALL on new tables and EXECUTE on new functions to the
-- API roles (and EXECUTE to PUBLIC): revoke everything, grant the minimum.
REVOKE ALL ON public.pbx_connections, public.pbx_connection_secrets, public.pbx_did_routes,
  public.pbx_extensions, public.calls, public.call_live, public.call_recordings, public.call_access_log,
  public.pbx_audit, public.pbx_presence, public.pbx_events_raw, public.pbx_settings, public.pbx_bank_numbers
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.pbx_connections, public.pbx_did_routes, public.pbx_extensions, public.calls,
  public.call_live, public.call_recordings, public.call_access_log, public.pbx_audit, public.pbx_presence,
  public.pbx_settings, public.pbx_bank_numbers
  TO authenticated;
GRANT INSERT, UPDATE ON public.pbx_settings TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.pbx_bank_numbers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pbx_connections, public.pbx_connection_secrets,
  public.pbx_did_routes, public.pbx_extensions, public.calls, public.call_live, public.call_recordings,
  public.pbx_presence, public.pbx_events_raw, public.pbx_settings, public.pbx_bank_numbers
  TO service_role;
-- The logs: no UPDATE, DELETE or TRUNCATE for anyone.
GRANT SELECT, INSERT ON public.call_access_log, public.pbx_audit TO service_role;
REVOKE ALL ON SEQUENCE public.call_access_log_id_seq, public.pbx_audit_id_seq, public.pbx_events_raw_id_seq
  FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SEQUENCE public.call_access_log_id_seq, public.pbx_audit_id_seq, public.pbx_events_raw_id_seq
  TO service_role;

DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('pbx_token_lock', 'pbx_token_swap', 'pbx_extensions_guard', 'calls_guard',
                'call_recordings_guard', 'pbx_recording_playable', 'call_access_log_guard',
                'pbx_audit_append_only', 'pbx_settings_stamp', 'pbx_can_view_call', 'pbx_my_extension',
                'pbx_set_disposition', 'pbx_link_call_contact', 'pbx_erase_contact_calls', 'pbx_purge')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
END $$;

-- authenticated: the calls policy's predicate and the people's functions.
GRANT EXECUTE ON FUNCTION
  public.pbx_can_view_call(public.calls), public.pbx_my_extension(),
  public.pbx_set_disposition(uuid, text, text), public.pbx_link_call_contact(uuid, uuid),
  public.pbx_erase_contact_calls(uuid, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.pbx_token_lock(uuid, text), public.pbx_token_swap(uuid, timestamptz, text, text),
  public.pbx_recording_playable(uuid), public.pbx_purge()
  TO service_role;
