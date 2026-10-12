-- 088_deal_rooms.sql — deal rooms (module 014c), database layer
--
-- A deal room is a REAL WhatsApp group, created through the Meta Cloud
-- API Groups API on the account's Meta number, with the customer, a
-- partner and optionally a bank officer, linked to a contact (and a
-- deal). Inside the CRM each room is also an internal-chat channel of
-- kind `deal_room` (087): its internal messages are the staff-only Team
-- notes, its members are who may open the room.
--
-- Shape:
--  * deal_rooms (one per group; status creating → open → … → closed),
--    deal_room_participants (the WhatsApp people, plus one `business`
--    row for our own number), participant_consents (append-only: no room
--    exists without the customer's recorded consent),
--    deal_room_join_requests, group_messages + group_message_receipts,
--    deal_files (+ the private `deal-files` bucket), deal_room_audit
--    (append-only) and bank_guest_policies (per bank: guests are off
--    until an admin records that the bank's DSA agreement was checked;
--    recording_allowed is read later by the phone module).
--  * deal_room_settings (one row per account): the group-invite
--    template, an approved Template Library copy (topic
--    `group_invite_link`) on the Meta number; the server sends it 1:1
--    to each invitee with the group id. A NULL name means not
--    configured; the optional Arabic copy is sent with language 'ar'.
--  * Writes: the SECURITY DEFINER functions below, each re-checking the
--    caller, or the service role (the Meta client and webhooks). Clients
--    get SELECT only (bank_guest_policies and deal_room_settings: admins
--    also write).
--  * Who sees a room (deal_room_access): owners and admins see every
--    room of their ACTIVE account ('supervisor'), a team leader the rooms
--    whose contact and deal they can see (can_view_contact /
--    can_view_deal); others there see rooms whose channel they are a
--    member of ('staff'); a bank guest of the room's account who is a
--    channel member sees it as 'guest' while their bank's guests are
--    allowed and the room has an approved, not removed participant of
--    their bank. A guest reads group messages from when they joined the
--    channel on (deal_room_visible_since).
--  * What a guest sees, inside their rooms only: deal_rooms and
--    group_messages / group_message_receipts rows, and the people
--    through the deal_room_roster view (display name, role, status —
--    no phone). Never deal_room_participants itself, consents, join
--    requests, audit or deal files. Phones are kept out of guest reach
--    by column grants that apply to every client: no client reads
--    deal_rooms.invite_link_hash (a bearer secret: the server hands it
--    out), group_messages.sender_wa_id or
--    group_message_receipts.participant_wa_id; staff identify a sender
--    or reader through sender_participant_id / participant_id, which the
--    service functions resolve (an unknown sender or joiner gets a
--    participant row with expected = false and no role). A client must
--    therefore name its columns (`select=*` is refused on those tables).
--  * Composite FKs on (id, account_id) keep every reference inside one
--    account; a guard trigger keeps a room on a deal_room channel of its
--    own account and on a provider='meta' number.
--
-- Re-runnable: every statement is guarded or replaces in place.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '088 must be applied by a superuser or BYPASSRLS role (the deal-room functions own RLS-forced tables)';
  END IF;
END $$;

-- deals had no (id, account_id) key for a composite FK to reference.
CREATE UNIQUE INDEX IF NOT EXISTS deals_id_account_key ON public.deals (id, account_id);

-- ---------- 1. Tables ----------

CREATE TABLE IF NOT EXISTS public.bank_guest_policies (
  account_id        uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  bank_code         text NOT NULL CHECK (bank_code <> '' AND bank_code = upper(btrim(bank_code))),
  guests_allowed    boolean NOT NULL DEFAULT false,
  recording_allowed boolean NOT NULL DEFAULT false,
  dsa_checked_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  dsa_checked_at    timestamptz,
  note              text CHECK (note IS NULL OR char_length(note) <= 2000),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, bank_code),
  -- guests only after the bank's DSA agreement was checked
  CONSTRAINT bank_guest_policies_dsa_checked CHECK (NOT guests_allowed OR dsa_checked_at IS NOT NULL)
);
DROP TRIGGER IF EXISTS set_updated_at ON public.bank_guest_policies;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.bank_guest_policies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Template names are Meta's: 1 to 512 lowercase letters, digits and
-- underscores. Postgres caps a regex bound at 255 ({1,512} is an
-- "invalid repetition count" on every insert), so the length is a
-- char_length.
CREATE TABLE IF NOT EXISTS public.deal_room_settings (
  account_id               uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  invite_template_name     text CHECK (invite_template_name IS NULL
                                       OR (invite_template_name ~ '^[a-z0-9_]+$' AND char_length(invite_template_name) <= 512)),
  invite_template_language text NOT NULL DEFAULT 'en' CHECK (invite_template_language ~ '^[a-z]{2,3}(_[A-Z]{2,3})?$'),
  invite_template_name_ar  text CHECK (invite_template_name_ar IS NULL
                                       OR (invite_template_name_ar ~ '^[a-z0-9_]+$' AND char_length(invite_template_name_ar) <= 512)),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
DROP TRIGGER IF EXISTS set_updated_at ON public.deal_room_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.deal_room_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.deal_rooms (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  channel_id         uuid NOT NULL UNIQUE REFERENCES public.chat_channels(id),
  contact_id         uuid NOT NULL,
  deal_id            uuid,
  whatsapp_config_id uuid,
  wa_group_id        text UNIQUE,
  create_request_id  text UNIQUE,
  subject            text NOT NULL CHECK (char_length(btrim(subject)) BETWEEN 1 AND 128),
  description        text CHECK (description IS NULL OR char_length(description) <= 2048),
  join_approval_mode text NOT NULL DEFAULT 'approval_required'
                     CHECK (join_approval_mode IN ('approval_required','auto_approve')),
  status             text NOT NULL DEFAULT 'creating'
                     CHECK (status IN ('creating','open','suspended','closing','closed','failed')),
  invite_link_hash   text,
  participant_count  integer NOT NULL DEFAULT 0 CHECK (participant_count >= 0),
  window_until       timestamptz,   -- group service window: last inbound group message + 24 h
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  opened_at          timestamptz,
  closed_at          timestamptz,
  close_reason       text,
  last_error         text,
  CONSTRAINT deal_rooms_id_account_key UNIQUE (id, account_id),
  CONSTRAINT deal_rooms_contact_fkey FOREIGN KEY (contact_id, account_id)
    REFERENCES public.contacts(id, account_id) ON DELETE CASCADE,
  CONSTRAINT deal_rooms_deal_fkey FOREIGN KEY (deal_id, account_id)
    REFERENCES public.deals(id, account_id) ON DELETE SET NULL (deal_id),
  CONSTRAINT deal_rooms_config_fkey FOREIGN KEY (whatsapp_config_id, account_id)
    REFERENCES public.whatsapp_config(id, account_id) ON DELETE SET NULL (whatsapp_config_id)
);
CREATE INDEX IF NOT EXISTS deal_rooms_account_idx ON public.deal_rooms (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deal_rooms_contact_idx ON public.deal_rooms (contact_id);
CREATE INDEX IF NOT EXISTS deal_rooms_deal_idx ON public.deal_rooms (deal_id) WHERE deal_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.participant_consents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL,
  room_id      uuid NOT NULL,
  contact_id   uuid NOT NULL,
  text_version text NOT NULL CHECK (char_length(btrim(text_version)) BETWEEN 1 AND 64),
  consent_text text NOT NULL CHECK (char_length(btrim(consent_text)) BETWEEN 1 AND 4000),
  method       text NOT NULL CHECK (method IN ('verbal','whatsapp','written','form')),
  given_at     timestamptz NOT NULL DEFAULT now(),
  recorded_by  uuid,
  CONSTRAINT participant_consents_room_fkey FOREIGN KEY (room_id, account_id)
    REFERENCES public.deal_rooms(id, account_id) ON DELETE CASCADE,
  CONSTRAINT participant_consents_contact_fkey FOREIGN KEY (contact_id, account_id)
    REFERENCES public.contacts(id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS participant_consents_room_idx ON public.participant_consents (room_id);

CREATE TABLE IF NOT EXISTS public.deal_room_participants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id           uuid NOT NULL,
  account_id        uuid NOT NULL,
  contact_id        uuid,
  display_name      text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
  phone             text CHECK (phone IS NULL OR phone ~ '^[0-9]{6,15}$'),
  wa_id             text,
  -- NULL only for someone nobody listed (joined through the link)
  role              text CHECK (role IN ('customer','partner','bank_guest','business')),
  bank_code         text CHECK (bank_code IS NULL OR (bank_code <> '' AND bank_code = upper(btrim(bank_code)))),
  expected          boolean NOT NULL DEFAULT true,
  consent_id        uuid REFERENCES public.participant_consents(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'invited'
                    CHECK (status IN ('pending_approval','invited','joined','left','removed','rejected')),
  invited_at        timestamptz,
  invite_message_id text,
  joined_at         timestamptz,
  left_at           timestamptz,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deal_room_participants_room_fkey FOREIGN KEY (room_id, account_id)
    REFERENCES public.deal_rooms(id, account_id) ON DELETE CASCADE,
  CONSTRAINT deal_room_participants_contact_fkey FOREIGN KEY (contact_id, account_id)
    REFERENCES public.contacts(id, account_id) ON DELETE SET NULL (contact_id),
  CONSTRAINT deal_room_participants_room_phone_key UNIQUE (room_id, phone),
  CONSTRAINT deal_room_participants_bank_code CHECK ((role IS NOT DISTINCT FROM 'bank_guest') = (bank_code IS NOT NULL)),
  CONSTRAINT deal_room_participants_listed_role CHECK (role IS NOT NULL OR NOT expected),
  CONSTRAINT deal_room_participants_phone CHECK (role IS NOT DISTINCT FROM 'business' OR phone IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS deal_room_participants_one_business
  ON public.deal_room_participants (room_id) WHERE role = 'business';
CREATE INDEX IF NOT EXISTS deal_room_participants_wa_idx ON public.deal_room_participants (room_id, wa_id);

CREATE TABLE IF NOT EXISTS public.deal_room_join_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id         uuid NOT NULL,
  account_id      uuid NOT NULL,
  join_request_id text NOT NULL,
  wa_id           text NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  decision        text NOT NULL DEFAULT 'pending'
                  CHECK (decision IN ('pending','approved','rejected','auto_approved')),
  decided_by      uuid,
  decided_at      timestamptz,
  CONSTRAINT deal_room_join_requests_room_fkey FOREIGN KEY (room_id, account_id)
    REFERENCES public.deal_rooms(id, account_id) ON DELETE CASCADE,
  CONSTRAINT deal_room_join_requests_key UNIQUE (room_id, join_request_id)
);

CREATE TABLE IF NOT EXISTS public.group_messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id               uuid NOT NULL,
  account_id            uuid NOT NULL,
  wa_message_id         text UNIQUE,
  direction             text NOT NULL CHECK (direction IN ('in','out')),
  sender_wa_id          text,
  sender_participant_id uuid REFERENCES public.deal_room_participants(id) ON DELETE SET NULL,
  staff_user_id         uuid,
  type                  text NOT NULL CHECK (type IN ('text','image','document','audio','video','sticker',
                                                      'template','unsupported','system')),
  body                  text,
  media                 jsonb,
  template_name         text,
  status                text CHECK (status IN ('pending','sent','delivered','read','failed')),
  error                 text,
  category              text,
  recipients_billed     integer CHECK (recipients_billed IS NULL OR recipients_billed >= 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT group_messages_room_fkey FOREIGN KEY (room_id, account_id)
    REFERENCES public.deal_rooms(id, account_id) ON DELETE CASCADE,
  -- a delivery status belongs to what we sent
  CONSTRAINT group_messages_status_out_only CHECK ((direction = 'out') = (status IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS group_messages_room_idx ON public.group_messages (room_id, created_at);

CREATE TABLE IF NOT EXISTS public.group_message_receipts (
  message_id        uuid NOT NULL REFERENCES public.group_messages(id) ON DELETE CASCADE,
  participant_wa_id text NOT NULL,
  participant_id    uuid REFERENCES public.deal_room_participants(id) ON DELETE SET NULL,
  status            text NOT NULL CHECK (status IN ('delivered','read','failed')),
  at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, participant_wa_id, status)
);

CREATE TABLE IF NOT EXISTS public.deal_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  deal_id      uuid,
  room_id      uuid,
  storage_path text,   -- NULL: a reference (e.g. a call recording held elsewhere)
  name         text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 255),
  mime         text,
  bytes        bigint CHECK (bytes IS NULL OR bytes >= 0),
  source       text NOT NULL CHECK (source IN ('deal_room_media','transcript','upload','call_recording')),
  ref_type     text,
  ref_id       text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deal_files_deal_fkey FOREIGN KEY (deal_id, account_id)
    REFERENCES public.deals(id, account_id) ON DELETE SET NULL (deal_id),
  CONSTRAINT deal_files_room_fkey FOREIGN KEY (room_id, account_id)
    REFERENCES public.deal_rooms(id, account_id) ON DELETE CASCADE,
  CONSTRAINT deal_files_path_in_account CHECK (
    storage_path IS NULL OR starts_with(storage_path, 'account-' || account_id::text || '/'))
);
CREATE INDEX IF NOT EXISTS deal_files_room_idx ON public.deal_files (room_id) WHERE room_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deal_files_deal_idx ON public.deal_files (deal_id) WHERE deal_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.deal_room_audit (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    uuid NOT NULL,
  account_id uuid NOT NULL,
  actor_id   uuid,   -- NULL: the server (webhooks, the Meta client)
  action     text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT deal_room_audit_room_fkey FOREIGN KEY (room_id, account_id)
    REFERENCES public.deal_rooms(id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS deal_room_audit_room_idx ON public.deal_room_audit (room_id, at);

-- ---------- 2. Guards ----------

-- Consents and audit are append-only for every writer. Only the cascade
-- of a deleted room (or, for a consent, a deleted contact) removes rows.
CREATE OR REPLACE FUNCTION public.deal_room_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.deal_rooms r WHERE r.id = OLD.room_id) THEN
      RETURN OLD;
    END IF;
    IF TG_TABLE_NAME = 'participant_consents' THEN
      IF NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = OLD.contact_id) THEN
        RETURN OLD;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END $$;
DROP TRIGGER IF EXISTS participant_consents_append_only ON public.participant_consents;
CREATE TRIGGER participant_consents_append_only BEFORE UPDATE OR DELETE ON public.participant_consents
  FOR EACH ROW EXECUTE FUNCTION public.deal_room_append_only();
DROP TRIGGER IF EXISTS deal_room_audit_append_only ON public.deal_room_audit;
CREATE TRIGGER deal_room_audit_append_only BEFORE UPDATE OR DELETE ON public.deal_room_audit
  FOR EACH ROW EXECUTE FUNCTION public.deal_room_append_only();

-- A room sits on a deal_room channel of its own account, and on the Meta
-- number: the Groups API is Cloud-API-only.
CREATE OR REPLACE FUNCTION public.deal_rooms_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.chat_channels c
                  WHERE c.id = NEW.channel_id AND c.kind = 'deal_room' AND c.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'deal rooms: the channel must be a deal_room channel of the same account'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.whatsapp_config_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.whatsapp_config w
                      WHERE w.id = NEW.whatsapp_config_id AND w.provider = 'meta') THEN
    RAISE EXCEPTION 'deal rooms: a deal room needs the Meta Cloud API number' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS deal_rooms_guard ON public.deal_rooms;
CREATE TRIGGER deal_rooms_guard BEFORE INSERT OR UPDATE OF channel_id, whatsapp_config_id, account_id
  ON public.deal_rooms FOR EACH ROW EXECUTE FUNCTION public.deal_rooms_guard();

-- ---------- 3. Access helpers ----------

-- A team leader supervises a room only when the room's customer is theirs
-- to see: its contact (can_view_contact) and its deal, if any
-- (can_view_deal), the checks deal_room_create makes. A leader with no
-- team sees no one else's room.
CREATE OR REPLACE FUNCTION public.deal_room_leader_sees(p_room uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.deal_rooms r
      JOIN public.contacts c ON c.id = r.contact_id AND c.account_id = r.account_id
      LEFT JOIN public.deals d ON d.id = r.deal_id AND d.account_id = r.account_id
     WHERE r.id = p_room
       AND public.can_view_contact(r.account_id, c.id, c.user_id)
       AND (r.deal_id IS NULL
            OR (d.id IS NOT NULL AND public.can_view_deal(r.account_id, public.deal_owner(d.assigned_to, d.user_id)))))
$$;

-- The caller's access to a room, in the room's account (their active
-- one): 'supervisor' (owner/admin, or a team leader who sees the room's
-- customer: deal_room_leader_sees), 'staff' (anyone else there who is a
-- member of the room's channel), 'guest' (a bank guest of the room's
-- account who is a member of the channel, while their bank's guests are
-- allowed and the room has an approved bank_guest participant of their
-- bank that was not removed), else NULL.
CREATE OR REPLACE FUNCTION public.deal_room_access(p_room uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
           WHEN r.account_id = public.current_account_id()
                AND (public.current_role_rank() >= 4
                     OR (public.current_role_rank() = 3 AND public.deal_room_leader_sees(r.id))) THEN 'supervisor'
           WHEN r.account_id = public.current_account_id() AND m.user_id IS NOT NULL THEN 'staff'
           WHEN m.user_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM public.profiles p
                    JOIN public.bank_guest_policies b
                      ON b.account_id = p.account_id AND b.bank_code = upper(btrim(p.bank_code)) AND b.guests_allowed
                   WHERE p.user_id = auth.uid() AND p.account_id = r.account_id
                     AND p.account_role = 'bank_guest' AND p.deactivated_at IS NULL
                     AND EXISTS (SELECT 1 FROM public.deal_room_participants x
                                  WHERE x.room_id = r.id AND x.role = 'bank_guest' AND x.bank_code = b.bank_code
                                    AND x.status NOT IN ('pending_approval','rejected','removed'))) THEN 'guest'
         END
    FROM public.deal_rooms r
    LEFT JOIN public.chat_channel_members m ON m.channel_id = r.channel_id AND m.user_id = auth.uid()
   WHERE r.id = p_room AND auth.uid() IS NOT NULL
$$;

-- p_user works in p_acct: a non-deactivated, non-guest membership.
CREATE OR REPLACE FUNCTION public.deal_room_is_staff(p_acct uuid, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.account_id = p_acct AND p.user_id = p_user
                    AND p.deactivated_at IS NULL AND p.account_role <> 'bank_guest')
$$;

-- Managers, in the room's account: owners and admins, a team leader who
-- sees the room's customer (deal_room_leader_sees), or an agent and up
-- who is the room channel's admin or owns the room's contact.
CREATE OR REPLACE FUNCTION public.deal_room_can_manage(p_room uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((
    SELECT r.account_id = public.current_account_id()
           AND (public.current_role_rank() >= 4
                OR (public.current_role_rank() = 3 AND public.deal_room_leader_sees(r.id))
                OR (public.current_role_rank() >= 2
                    AND (EXISTS (SELECT 1 FROM public.chat_channel_members m
                                  WHERE m.channel_id = r.channel_id AND m.user_id = auth.uid() AND m.role = 'admin')
                         OR EXISTS (SELECT 1 FROM public.contacts c
                                     WHERE c.id = r.contact_id AND c.user_id = auth.uid()))))
      FROM public.deal_rooms r
     WHERE r.id = p_room AND auth.uid() IS NOT NULL), false)
$$;

-- Posting a customer-visible group message: managers, staff channel
-- members (not viewers), and a bank guest who is a member of the room's
-- channel. Rights only: the sender checks the room's status.
CREATE OR REPLACE FUNCTION public.deal_room_can_post(p_room uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((
    SELECT CASE public.deal_room_access(r.id)
             WHEN 'supervisor' THEN true
             WHEN 'staff' THEN public.current_role_rank() >= 2
             WHEN 'guest' THEN true
             ELSE public.deal_room_can_manage(r.id)
           END
      FROM public.deal_rooms r
     WHERE r.id = p_room), false)
$$;

-- The oldest group message the caller may read in a room: all of them
-- for staff, a guest's from when they joined the room's channel, none
-- (NULL) without access.
CREATE OR REPLACE FUNCTION public.deal_room_visible_since(p_room uuid)
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE public.deal_room_access(p_room)
           WHEN 'supervisor' THEN '-infinity'::timestamptz
           WHEN 'staff' THEN '-infinity'::timestamptz
           WHEN 'guest' THEN (SELECT m.joined_at FROM public.deal_rooms r
                                JOIN public.chat_channel_members m ON m.channel_id = r.channel_id
                               WHERE r.id = p_room AND m.user_id = auth.uid())
         END
$$;

-- Server-only functions refuse a signed-in caller even if a grant slips.
CREATE OR REPLACE FUNCTION public.deal_room_assert_service()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'deal rooms: server-only function' USING ERRCODE = '42501';
  END IF;
END $$;

-- The participant a WhatsApp id belongs to: by wa_id, else by phone.
CREATE OR REPLACE FUNCTION public.deal_room_find_participant(p_room uuid, p_wa_id text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.id FROM public.deal_room_participants p
   WHERE p.room_id = p_room
     AND (p.wa_id = p_wa_id OR p.phone = regexp_replace(coalesce(p_wa_id, ''), '\D', '', 'g'))
   ORDER BY (p.wa_id IS NOT DISTINCT FROM p_wa_id) DESC
   LIMIT 1
$$;

-- An unknown WhatsApp id that is in the group (joined, or posted): a
-- participant nobody listed (expected = false, no role).
CREATE OR REPLACE FUNCTION public.deal_room_add_unlisted(p_room uuid, p_acct uuid, p_wa_id text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_digits text := regexp_replace(coalesce(p_wa_id, ''), '\D', '', 'g');
  v_id     uuid;
BEGIN
  IF v_digits !~ '^[0-9]{6,15}$' THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.deal_room_participants (room_id, account_id, display_name, phone, wa_id, role, expected,
                                             status, joined_at)
  VALUES (p_room, p_acct, '+' || v_digits, v_digits, p_wa_id, NULL, false, 'joined', now())
  ON CONFLICT (room_id, phone) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    v_id := public.deal_room_find_participant(p_room, p_wa_id);
  ELSE
    INSERT INTO public.deal_room_audit (room_id, account_id, actor_id, action, detail)
    VALUES (p_room, p_acct, NULL, 'participant_unlisted', jsonb_build_object('participant_id', v_id));
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.deal_room_refresh_count(p_room uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.deal_rooms r
     SET participant_count = (SELECT count(*) FROM public.deal_room_participants p
                               WHERE p.room_id = r.id AND p.status = 'joined')
   WHERE r.id = p_room
$$;

-- ---------- 4. Client functions ----------

-- p_participants: [{display_name, phone, role, contact_id?, bank_code?}],
-- 1–7 people, role customer | partner | bank_guest, at least one
-- customer. p_consent: {text_version, consent_text, method}, required.
CREATE OR REPLACE FUNCTION public.deal_room_create(
  p_contact_id uuid, p_deal_id uuid, p_whatsapp_config_id uuid, p_subject text, p_description text,
  p_participants jsonb, p_consent jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_acct      uuid := public.current_account_id();
  v_rank      integer := public.current_role_rank();
  v_contact   public.contacts;
  v_deal      public.deals;
  v_cfg       public.whatsapp_config;
  v_subject   text := btrim(coalesce(p_subject, ''));
  v_desc      text := nullif(btrim(coalesce(p_description, '')), '');
  v_p         jsonb;
  v_rows      jsonb := '[]'::jsonb;
  v_name      text;
  v_phone     text;
  v_role      text;
  v_bank      text;
  v_pcontact  uuid;
  v_phones    text[] := '{}';
  v_customers integer := 0;
  v_pending   integer := 0;
  v_channel   uuid;
  v_room      uuid;
  v_consent   uuid;
BEGIN
  -- current_account_id() is NULL for a bank guest: guests never create.
  IF v_uid IS NULL OR v_acct IS NULL THEN
    RAISE EXCEPTION 'deal rooms: no active workspace' USING ERRCODE = '42501';
  END IF;
  IF v_rank < 2 THEN
    RAISE EXCEPTION 'deal rooms: viewers cannot create deal rooms' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_contact FROM public.contacts WHERE id = p_contact_id AND account_id = v_acct;
  IF NOT FOUND OR NOT (v_rank >= 4 OR public.can_view_contact(v_acct, v_contact.id, v_contact.user_id)) THEN
    RAISE EXCEPTION 'deal rooms: contact not found' USING ERRCODE = '42501';
  END IF;
  IF v_contact.opted_out_at IS NOT NULL OR v_contact.do_not_contact_at IS NOT NULL THEN
    RAISE EXCEPTION 'deal rooms: % has opted out or is marked do-not-contact',
      coalesce(v_contact.name, v_contact.phone) USING ERRCODE = '22023';
  END IF;

  IF p_deal_id IS NOT NULL THEN
    SELECT * INTO v_deal FROM public.deals WHERE id = p_deal_id AND account_id = v_acct;
    IF NOT FOUND OR NOT (v_rank >= 4 OR public.can_view_deal(v_acct,
         coalesce((SELECT p.user_id FROM public.profiles p WHERE p.id = v_deal.assigned_to), v_deal.user_id))) THEN
      RAISE EXCEPTION 'deal rooms: deal not found' USING ERRCODE = '42501';
    END IF;
    IF v_deal.contact_id IS DISTINCT FROM p_contact_id AND v_deal.contact_id IS NOT NULL THEN
      RAISE EXCEPTION 'deal rooms: the deal belongs to another contact' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT * INTO v_cfg FROM public.whatsapp_config WHERE id = p_whatsapp_config_id AND account_id = v_acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deal rooms: WhatsApp number not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_cfg.provider <> 'meta' THEN
    RAISE EXCEPTION 'deal rooms: a deal room needs the Meta Cloud API number (WhatsApp groups are not available on %)',
      v_cfg.provider USING ERRCODE = '22023';
  END IF;

  IF char_length(v_subject) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'deal rooms: the subject must be 1 to 128 characters' USING ERRCODE = '22023';
  END IF;
  IF char_length(coalesce(v_desc, '')) > 2048 THEN
    RAISE EXCEPTION 'deal rooms: the description is longer than 2048 characters' USING ERRCODE = '22023';
  END IF;

  IF p_consent IS NULL OR jsonb_typeof(p_consent) <> 'object'
     OR btrim(coalesce(p_consent->>'text_version', '')) = ''
     OR btrim(coalesce(p_consent->>'consent_text', '')) = ''
     OR coalesce(p_consent->>'method', '') NOT IN ('verbal','whatsapp','written','form') THEN
    RAISE EXCEPTION 'deal rooms: the customer''s recorded consent (text_version, consent_text, method) is required'
      USING ERRCODE = '22023';
  END IF;

  IF p_participants IS NULL OR jsonb_typeof(p_participants) <> 'array'
     OR jsonb_array_length(p_participants) NOT BETWEEN 1 AND 7 THEN
    RAISE EXCEPTION 'deal rooms: invite 1 to 7 people (WhatsApp allows 8 including the business number)'
      USING ERRCODE = '22023';
  END IF;

  FOR v_p IN SELECT value FROM jsonb_array_elements(p_participants) LOOP
    IF jsonb_typeof(v_p) <> 'object' THEN
      RAISE EXCEPTION 'deal rooms: each participant must be an object' USING ERRCODE = '22023';
    END IF;
    v_name  := btrim(coalesce(v_p->>'display_name', ''));
    v_phone := regexp_replace(public.chat_normalize_digits(coalesce(v_p->>'phone', '')), '\D', '', 'g');
    v_role  := v_p->>'role';
    v_bank  := nullif(upper(btrim(coalesce(v_p->>'bank_code', ''))), '');
    IF char_length(v_name) NOT BETWEEN 1 AND 120 THEN
      RAISE EXCEPTION 'deal rooms: every participant needs a display name (1 to 120 characters)' USING ERRCODE = '22023';
    END IF;
    IF v_phone !~ '^[0-9]{6,15}$' THEN
      RAISE EXCEPTION 'deal rooms: % has no valid phone number', v_name USING ERRCODE = '22023';
    END IF;
    IF v_role IS NULL OR v_role NOT IN ('customer','partner','bank_guest') THEN
      RAISE EXCEPTION 'deal rooms: % has an unknown role (customer, partner or bank_guest)', v_name
        USING ERRCODE = '22023';
    END IF;
    IF v_phone = ANY (v_phones) THEN
      RAISE EXCEPTION 'deal rooms: % is listed twice (same phone number)', v_name USING ERRCODE = '22023';
    END IF;
    v_phones := v_phones || v_phone;

    IF v_role = 'bank_guest' THEN
      IF v_bank IS NULL THEN
        RAISE EXCEPTION 'deal rooms: bank guest % needs a bank code', v_name USING ERRCODE = '22023';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.bank_guest_policies b
                      WHERE b.account_id = v_acct AND b.bank_code = v_bank AND b.guests_allowed) THEN
        RAISE EXCEPTION 'deal rooms: % officers cannot join customer groups (the bank''s DSA agreement is not checked)',
          v_bank USING ERRCODE = '22023';
      END IF;
      IF v_rank < 3 THEN
        v_pending := v_pending + 1;
      END IF;
    ELSE
      v_bank := NULL;
    END IF;

    v_pcontact := NULL;
    IF nullif(v_p->>'contact_id', '') IS NOT NULL THEN
      v_pcontact := (v_p->>'contact_id')::uuid;
      IF NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = v_pcontact AND c.account_id = v_acct) THEN
        RAISE EXCEPTION 'deal rooms: the contact given for % was not found', v_name USING ERRCODE = 'P0002';
      END IF;
    END IF;
    -- Nobody who asked not to be contacted is put in a group.
    IF EXISTS (SELECT 1 FROM public.contacts c
                WHERE c.account_id = v_acct
                  AND (c.phone_normalized = v_phone OR c.id = v_pcontact)
                  AND (c.opted_out_at IS NOT NULL OR c.do_not_contact_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'deal rooms: % has opted out or is marked do-not-contact', v_name USING ERRCODE = '22023';
    END IF;
    IF v_pcontact IS NULL THEN
      SELECT c.id INTO v_pcontact FROM public.contacts c
       WHERE c.account_id = v_acct AND c.phone_normalized = v_phone;
    END IF;

    IF v_role = 'customer' THEN
      v_customers := v_customers + 1;
    END IF;
    v_rows := v_rows || jsonb_build_object('display_name', v_name, 'phone', v_phone, 'role', v_role,
                                           'bank_code', v_bank, 'contact_id', v_pcontact);
  END LOOP;
  IF v_customers = 0 THEN
    RAISE EXCEPTION 'deal rooms: at least one participant must be the customer' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.chat_channels (account_id, kind, name, created_by)
  VALUES (v_acct, 'deal_room', left(v_subject, 80), v_uid)
  RETURNING id INTO v_channel;
  INSERT INTO public.chat_channel_members (channel_id, user_id, role) VALUES (v_channel, v_uid, 'admin');
  IF v_contact.user_id IS DISTINCT FROM v_uid AND public.deal_room_is_staff(v_acct, v_contact.user_id) THEN
    INSERT INTO public.chat_channel_members (channel_id, user_id, role)
    VALUES (v_channel, v_contact.user_id, 'member') ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO public.deal_rooms (account_id, channel_id, contact_id, deal_id, whatsapp_config_id,
                                 subject, description, created_by)
  VALUES (v_acct, v_channel, p_contact_id, p_deal_id, p_whatsapp_config_id, v_subject, v_desc, v_uid)
  RETURNING id INTO v_room;

  INSERT INTO public.participant_consents (account_id, room_id, contact_id, text_version, consent_text,
                                           method, recorded_by)
  VALUES (v_acct, v_room, p_contact_id, btrim(p_consent->>'text_version'), btrim(p_consent->>'consent_text'),
          p_consent->>'method', v_uid)
  RETURNING id INTO v_consent;

  -- our own number; joins when the group is created
  INSERT INTO public.deal_room_participants (room_id, account_id, display_name, role, status, created_by)
  VALUES (v_room, v_acct, left(coalesce(nullif(btrim(v_cfg.label), ''), 'Business'), 120), 'business',
          'invited', v_uid);

  -- an agent's bank guest waits for a team leader's approval
  INSERT INTO public.deal_room_participants (room_id, account_id, contact_id, display_name, phone, role,
                                             bank_code, consent_id, status, created_by)
  SELECT v_room, v_acct, (x->>'contact_id')::uuid, x->>'display_name', x->>'phone', x->>'role',
         x->>'bank_code',
         CASE WHEN x->>'role' = 'customer' THEN v_consent END,
         CASE WHEN x->>'role' = 'bank_guest' AND v_rank < 3 THEN 'pending_approval' ELSE 'invited' END,
         v_uid
    FROM jsonb_array_elements(v_rows) x;

  INSERT INTO public.deal_room_audit (room_id, account_id, actor_id, action, detail)
  VALUES (v_room, v_acct, v_uid, 'created',
          jsonb_build_object('participants', jsonb_array_length(v_rows), 'guests_pending_approval', v_pending,
                             'consent_id', v_consent, 'deal_id', p_deal_id));
  RETURN v_room;
END $$;

-- A bank guest an agent listed: a team leader or admin lets them in
-- ('invited') or not ('rejected').
CREATE OR REPLACE FUNCTION public.deal_room_approve_participant(p_participant_id uuid, p_approve boolean)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_p   public.deal_room_participants;
  v_new text;
BEGIN
  SELECT * INTO v_p FROM public.deal_room_participants WHERE id = p_participant_id FOR UPDATE;
  IF v_uid IS NULL OR NOT FOUND OR v_p.account_id IS DISTINCT FROM public.current_account_id() THEN
    RAISE EXCEPTION 'deal rooms: participant not found' USING ERRCODE = '42501';
  END IF;
  IF public.current_role_rank() < 3 THEN
    RAISE EXCEPTION 'deal rooms: only a team leader or an admin can approve a participant' USING ERRCODE = '42501';
  END IF;
  IF p_approve IS NULL THEN
    RAISE EXCEPTION 'deal rooms: approve or reject' USING ERRCODE = '22023';
  END IF;
  IF v_p.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'deal rooms: % is not waiting for approval (status %)', v_p.display_name, v_p.status
      USING ERRCODE = '22023';
  END IF;
  IF p_approve AND v_p.role = 'bank_guest'
     AND NOT EXISTS (SELECT 1 FROM public.bank_guest_policies b
                      WHERE b.account_id = v_p.account_id AND b.bank_code = v_p.bank_code AND b.guests_allowed) THEN
    RAISE EXCEPTION 'deal rooms: % officers cannot join customer groups (the bank''s DSA agreement is not checked)',
      v_p.bank_code USING ERRCODE = '22023';
  END IF;
  v_new := CASE WHEN p_approve THEN 'invited' ELSE 'rejected' END;
  UPDATE public.deal_room_participants SET status = v_new WHERE id = v_p.id;
  INSERT INTO public.deal_room_audit (room_id, account_id, actor_id, action, detail)
  VALUES (v_p.room_id, v_p.account_id, v_uid,
          CASE WHEN p_approve THEN 'participant_approved' ELSE 'participant_rejected' END,
          jsonb_build_object('participant_id', v_p.id, 'role', v_p.role, 'bank_code', v_p.bank_code));
  RETURN v_new;
END $$;

-- Staff of the room's account join its channel (Team notes, the room).
CREATE OR REPLACE FUNCTION public.deal_room_add_staff(p_room uuid, p_user_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_r   public.deal_rooms;
  v_u   uuid;
  v_k   integer;
  v_n   integer := 0;
BEGIN
  SELECT * INTO v_r FROM public.deal_rooms WHERE id = p_room;
  IF v_uid IS NULL OR NOT FOUND OR NOT public.deal_room_can_manage(p_room) THEN
    RAISE EXCEPTION 'deal rooms: only a manager of this room can add people' USING ERRCODE = '42501';
  END IF;
  FOREACH v_u IN ARRAY coalesce(p_user_ids, '{}'::uuid[]) LOOP
    IF v_u IS NULL OR NOT public.deal_room_is_staff(v_r.account_id, v_u) THEN
      RAISE EXCEPTION 'deal rooms: % is not staff of this workspace', v_u USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.chat_channel_members (channel_id, user_id, role)
    VALUES (v_r.channel_id, v_u, 'member') ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_k = ROW_COUNT;
    v_n := v_n + v_k;
  END LOOP;
  IF v_n > 0 THEN
    INSERT INTO public.deal_room_audit (room_id, account_id, actor_id, action, detail)
    VALUES (v_r.id, v_r.account_id, v_uid, 'staff_added', jsonb_build_object('user_ids', to_jsonb(p_user_ids)));
  END IF;
  RETURN v_n;
END $$;

-- A bank guest login joins the room's channel, for a bank that has an
-- approved bank_guest participant in the room and is still cleared.
CREATE OR REPLACE FUNCTION public.deal_room_add_guest_user(p_room uuid, p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_r    public.deal_rooms;
  v_bank text;
BEGIN
  SELECT * INTO v_r FROM public.deal_rooms WHERE id = p_room;
  IF v_uid IS NULL OR NOT FOUND OR v_r.account_id IS DISTINCT FROM public.current_account_id()
     OR public.current_role_rank() < 3 THEN
    RAISE EXCEPTION 'deal rooms: only a team leader or an admin can add a bank guest' USING ERRCODE = '42501';
  END IF;
  SELECT upper(btrim(p.bank_code)) INTO v_bank FROM public.profiles p
   WHERE p.account_id = v_r.account_id AND p.user_id = p_user_id
     AND p.account_role = 'bank_guest' AND p.deactivated_at IS NULL;
  IF v_bank IS NULL THEN
    RAISE EXCEPTION 'deal rooms: that person is not a bank guest of this workspace' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.deal_room_participants x
                  WHERE x.room_id = p_room AND x.role = 'bank_guest' AND x.bank_code = v_bank
                    AND x.status NOT IN ('pending_approval','rejected','removed')) THEN
    RAISE EXCEPTION 'deal rooms: this room has no approved % participant', v_bank USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bank_guest_policies b
                  WHERE b.account_id = v_r.account_id AND b.bank_code = v_bank AND b.guests_allowed) THEN
    RAISE EXCEPTION 'deal rooms: % officers cannot join customer groups (the bank''s DSA agreement is not checked)',
      v_bank USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.chat_channel_members (channel_id, user_id, role)
  VALUES (v_r.channel_id, p_user_id, 'guest') ON CONFLICT DO NOTHING;
  IF FOUND THEN
    INSERT INTO public.deal_room_audit (room_id, account_id, actor_id, action, detail)
    VALUES (v_r.id, v_r.account_id, v_uid, 'guest_user_added',
            jsonb_build_object('user_id', p_user_id, 'bank_code', v_bank));
  END IF;
END $$;

-- ---------- 5. Server functions (service role) ----------

-- The Meta client is about to create the group with this request id.
CREATE OR REPLACE FUNCTION public.deal_room_mark_requested(p_room uuid, p_request_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_r public.deal_rooms;
BEGIN
  PERFORM public.deal_room_assert_service();
  IF btrim(coalesce(p_request_id, '')) = '' THEN
    RAISE EXCEPTION 'deal rooms: a request id is required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_r FROM public.deal_rooms WHERE id = p_room FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deal rooms: room not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_r.create_request_id IS NOT DISTINCT FROM p_request_id THEN
    RETURN;   -- replay
  END IF;
  IF v_r.status NOT IN ('creating','failed') OR v_r.wa_group_id IS NOT NULL THEN
    RAISE EXCEPTION 'deal rooms: the room is % and cannot be created again', v_r.status USING ERRCODE = '22023';
  END IF;
  UPDATE public.deal_rooms SET create_request_id = p_request_id, status = 'creating', last_error = NULL
   WHERE id = p_room;
  INSERT INTO public.deal_room_audit (room_id, account_id, actor_id, action, detail)
  VALUES (v_r.id, v_r.account_id, NULL, 'create_requested', jsonb_build_object('request_id', p_request_id));
END $$;

-- Meta created the group: the room opens and our number is in it.
CREATE OR REPLACE FUNCTION public.deal_room_group_created(p_request_id text, p_group_id text, p_invite_link_hash text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_r public.deal_rooms;
BEGIN
  PERFORM public.deal_room_assert_service();
  IF btrim(coalesce(p_group_id, '')) = '' THEN
    RAISE EXCEPTION 'deal rooms: a group id is required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_r FROM public.deal_rooms WHERE create_request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deal rooms: no room for create request %', p_request_id USING ERRCODE = 'P0002';
  END IF;
  IF v_r.wa_group_id IS NOT NULL THEN
    IF v_r.wa_group_id <> p_group_id THEN
      RAISE EXCEPTION 'deal rooms: the room already has another group' USING ERRCODE = '22023';
    END IF;
    IF p_invite_link_hash IS NOT NULL THEN
      UPDATE public.deal_rooms SET invite_link_hash = p_invite_link_hash WHERE id = v_r.id;
    END IF;
    RETURN v_r.id;   -- replay
  END IF;
  IF v_r.status NOT IN ('creating','failed') THEN
    RAISE EXCEPTION 'deal rooms: the room is % and cannot open', v_r.status USING ERRCODE = '22023';
  END IF;
  UPDATE public.deal_rooms
     SET wa_group_id = p_group_id, invite_link_hash = p_invite_link_hash, status = 'open',
         opened_at = now(), last_error = NULL
   WHERE id = v_r.id;
  UPDATE public.deal_room_participants SET status = 'joined', joined_at = now()
   WHERE room_id = v_r.id AND role = 'business';
  PERFORM public.deal_room_refresh_count(v_r.id);
  INSERT INTO public.deal_room_audit (room_id, account_id, actor_id, action, detail)
  VALUES (v_r.id, v_r.account_id, NULL, 'group_created', jsonb_build_object('group_id', p_group_id));
  RETURN v_r.id;
END $$;

CREATE OR REPLACE FUNCTION public.deal_room_set_status(p_room uuid, p_status text, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_r public.deal_rooms;
BEGIN
  PERFORM public.deal_room_assert_service();
  IF p_status IS NULL OR p_status NOT IN ('creating','open','suspended','closing','closed','failed') THEN
    RAISE EXCEPTION 'deal rooms: unknown status %', p_status USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_r FROM public.deal_rooms WHERE id = p_room FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deal rooms: room not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_r.status = p_status THEN
    RETURN;
  END IF;
  IF v_r.status = 'closed' THEN
    RAISE EXCEPTION 'deal rooms: a closed room cannot change status' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'open' AND v_r.wa_group_id IS NULL THEN
    RAISE EXCEPTION 'deal rooms: a room opens only once its group exists' USING ERRCODE = '22023';
  END IF;
  UPDATE public.deal_rooms
     SET status       = p_status,
         closed_at    = CASE WHEN p_status = 'closed' THEN now() ELSE closed_at END,
         close_reason = CASE WHEN p_status IN ('closing','closed') THEN coalesce(p_reason, close_reason)
                             ELSE close_reason END,
         last_error   = CASE WHEN p_status = 'failed' THEN p_reason ELSE last_error END
   WHERE id = p_room;
  INSERT INTO public.deal_room_audit (room_id, account_id, actor_id, action, detail)
  VALUES (v_r.id, v_r.account_id, NULL, 'status_changed',
          jsonb_build_object('from', v_r.status, 'to', p_status, 'reason', p_reason));
END $$;

-- A join request: 'auto_approved' when it comes from an invited,
-- expected participant (the caller then approves it at Meta), else
-- 'pending' for a manager. A redelivery returns the stored decision.
CREATE OR REPLACE FUNCTION public.deal_room_record_join_request(p_group_id text, p_join_request_id text, p_wa_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_r        public.deal_rooms;
  v_pid      uuid;
  v_p        public.deal_room_participants;
  v_decision text := 'pending';
  v_stored   text;
BEGIN
  PERFORM public.deal_room_assert_service();
  IF btrim(coalesce(p_join_request_id, '')) = '' OR btrim(coalesce(p_wa_id, '')) = '' THEN
    RAISE EXCEPTION 'deal rooms: a join request needs its id and the requester' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_r FROM public.deal_rooms WHERE wa_group_id = p_group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deal rooms: unknown group' USING ERRCODE = 'P0002';
  END IF;
  SELECT decision INTO v_stored FROM public.deal_room_join_requests
   WHERE room_id = v_r.id AND join_request_id = p_join_request_id;
  IF FOUND THEN
    RETURN v_stored;
  END IF;
  v_pid := public.deal_room_find_participant(v_r.id, p_wa_id);
  IF v_pid IS NOT NULL THEN
    SELECT * INTO v_p FROM public.deal_room_participants WHERE id = v_pid;
    IF v_p.status = 'invited' AND v_p.expected THEN
      v_decision := 'auto_approved';
    END IF;
  END IF;
  INSERT INTO public.deal_room_join_requests (room_id, account_id, join_request_id, wa_id, decision, decided_at)
  VALUES (v_r.id, v_r.account_id, p_join_request_id, p_wa_id, v_decision,
          CASE WHEN v_decision = 'auto_approved' THEN now() END)
  ON CONFLICT (room_id, join_request_id) DO NOTHING;
  IF NOT FOUND THEN   -- a concurrent redelivery won
    SELECT decision INTO v_stored FROM public.deal_room_join_requests
     WHERE room_id = v_r.id AND join_request_id = p_join_request_id;
    RETURN v_stored;
  END IF;
  IF v_decision = 'auto_approved' AND v_p.wa_id IS NULL THEN
    UPDATE public.deal_room_participants SET wa_id = p_wa_id WHERE id = v_pid;
  END IF;
  INSERT INTO public.deal_room_audit (room_id, account_id, actor_id, action, detail)
  VALUES (v_r.id, v_r.account_id, NULL, 'join_request',
          jsonb_build_object('join_request_id', p_join_request_id, 'decision', v_decision, 'participant_id', v_pid));
  RETURN v_decision;
END $$;

-- Membership as WhatsApp reports it; keeps participant_count (joined
-- rows, our number included). Returns the event, or 'unknown' when it
-- names nobody this room knows (a joiner nobody listed is added).
CREATE OR REPLACE FUNCTION public.deal_room_participant_event(p_group_id text, p_wa_id text, p_event text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_r   public.deal_rooms;
  v_pid uuid;
  v_old text;
BEGIN
  PERFORM public.deal_room_assert_service();
  IF p_event IS NULL OR p_event NOT IN ('joined','left','removed') THEN
    RAISE EXCEPTION 'deal rooms: unknown participant event %', p_event USING ERRCODE = '22023';
  END IF;
  IF btrim(coalesce(p_wa_id, '')) = '' THEN
    RAISE EXCEPTION 'deal rooms: the event names no participant' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_r FROM public.deal_rooms WHERE wa_group_id = p_group_id FOR UPDATE;   -- one count writer per room
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deal rooms: unknown group' USING ERRCODE = 'P0002';
  END IF;
  v_pid := public.deal_room_find_participant(v_r.id, p_wa_id);
  IF v_pid IS NULL THEN
    IF p_event <> 'joined' THEN
      RETURN 'unknown';
    END IF;
    v_pid := public.deal_room_add_unlisted(v_r.id, v_r.account_id, p_wa_id);
    IF v_pid IS NULL THEN
      RETURN 'unknown';
    END IF;
  ELSE
    SELECT status INTO v_old FROM public.deal_room_participants WHERE id = v_pid;
    IF v_old IS DISTINCT FROM p_event THEN
      UPDATE public.deal_room_participants
         SET status    = p_event,
             wa_id     = coalesce(wa_id, p_wa_id),
             joined_at = CASE WHEN p_event = 'joined' THEN now() ELSE joined_at END,
             left_at   = CASE WHEN p_event = 'joined' THEN left_at ELSE now() END
       WHERE id = v_pid;
      INSERT INTO public.deal_room_audit (room_id, account_id, actor_id, action, detail)
      VALUES (v_r.id, v_r.account_id, NULL, 'participant_' || p_event,
              jsonb_build_object('participant_id', v_pid, 'from', v_old));
    END IF;
  END IF;
  PERFORM public.deal_room_refresh_count(v_r.id);
  RETURN p_event;
END $$;

-- One group message, inbound (webhook) or outbound (after the send),
-- deduplicated on wa_message_id. Inbound reopens the group's 24-hour
-- service window and resolves the sender to a participant; outbound is
-- attributed to our number's participant row and the staff user.
CREATE OR REPLACE FUNCTION public.deal_room_record_message(
  p_group_id text, p_direction text, p_type text,
  p_wa_message_id text DEFAULT NULL, p_sender_wa_id text DEFAULT NULL, p_body text DEFAULT NULL,
  p_media jsonb DEFAULT NULL, p_template_name text DEFAULT NULL, p_staff_user_id uuid DEFAULT NULL,
  p_status text DEFAULT NULL, p_error text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_r      public.deal_rooms;
  v_id     uuid;
  v_sender uuid;
BEGIN
  PERFORM public.deal_room_assert_service();
  IF p_direction IS NULL OR p_direction NOT IN ('in','out') THEN
    RAISE EXCEPTION 'deal rooms: direction must be in or out' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_r FROM public.deal_rooms WHERE wa_group_id = p_group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deal rooms: unknown group' USING ERRCODE = 'P0002';
  END IF;
  IF p_wa_message_id IS NOT NULL THEN
    SELECT id INTO v_id FROM public.group_messages WHERE wa_message_id = p_wa_message_id;
    IF FOUND THEN
      RETURN v_id;   -- redelivery
    END IF;
  END IF;
  IF p_direction = 'in' THEN
    IF btrim(coalesce(p_sender_wa_id, '')) = '' THEN
      RAISE EXCEPTION 'deal rooms: an inbound message needs its sender' USING ERRCODE = '22023';
    END IF;
    v_sender := coalesce(public.deal_room_find_participant(v_r.id, p_sender_wa_id),
                         public.deal_room_add_unlisted(v_r.id, v_r.account_id, p_sender_wa_id));
  ELSE
    SELECT id INTO v_sender FROM public.deal_room_participants WHERE room_id = v_r.id AND role = 'business';
  END IF;
  INSERT INTO public.group_messages (room_id, account_id, wa_message_id, direction, sender_wa_id,
                                     sender_participant_id, staff_user_id, type, body, media, template_name,
                                     status, error)
  VALUES (v_r.id, v_r.account_id, p_wa_message_id, p_direction,
          CASE WHEN p_direction = 'in' THEN p_sender_wa_id END, v_sender,
          CASE WHEN p_direction = 'out' THEN p_staff_user_id END,
          p_type, p_body, p_media, p_template_name,
          CASE WHEN p_direction = 'out'
               THEN coalesce(p_status, CASE WHEN p_wa_message_id IS NULL THEN 'pending' ELSE 'sent' END) END,
          p_error)
  ON CONFLICT (wa_message_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN   -- a concurrent redelivery won
    SELECT id INTO v_id FROM public.group_messages WHERE wa_message_id = p_wa_message_id;
    RETURN v_id;
  END IF;
  IF p_direction = 'in' THEN
    UPDATE public.deal_rooms SET window_until = now() + interval '24 hours' WHERE id = v_r.id;
    PERFORM public.deal_room_refresh_count(v_r.id);
  END IF;
  RETURN v_id;
END $$;

-- A per-participant receipt. The message's own status moves forward only
-- (pending → sent → delivered → read); failed only from pending/sent.
-- false: unknown message or a redelivered receipt.
CREATE OR REPLACE FUNCTION public.deal_room_record_receipt(p_wa_message_id text, p_participant_wa_id text, p_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_m public.group_messages;
BEGIN
  PERFORM public.deal_room_assert_service();
  IF p_status IS NULL OR p_status NOT IN ('delivered','read','failed') THEN
    RAISE EXCEPTION 'deal rooms: unknown receipt status %', p_status USING ERRCODE = '22023';
  END IF;
  IF btrim(coalesce(p_participant_wa_id, '')) = '' THEN
    RAISE EXCEPTION 'deal rooms: the receipt names no participant' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_m FROM public.group_messages WHERE wa_message_id = p_wa_message_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO public.group_message_receipts (message_id, participant_wa_id, participant_id, status)
  VALUES (v_m.id, p_participant_wa_id, public.deal_room_find_participant(v_m.room_id, p_participant_wa_id), p_status)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_m.direction = 'out' THEN
    IF p_status = 'failed' THEN
      IF v_m.status IN ('pending','sent') THEN
        UPDATE public.group_messages SET status = 'failed' WHERE id = v_m.id;
      END IF;
    ELSIF (CASE p_status WHEN 'delivered' THEN 3 ELSE 4 END)
          > (CASE v_m.status WHEN 'pending' THEN 1 WHEN 'sent' THEN 2 WHEN 'delivered' THEN 3
                             WHEN 'read' THEN 4 ELSE 5 END) THEN
      UPDATE public.group_messages SET status = p_status WHERE id = v_m.id;
    END IF;
  END IF;
  RETURN true;
END $$;

-- ---------- 6. The guest-safe roster ----------

-- Everyone who can open a room (a guest included) sees its people here:
-- name, role and status, never a phone number or WhatsApp id. Runs with
-- the owner's rights, so the WHERE clause is the whole access rule. A
-- guest sees 'Unlisted number ending NN' instead of a name the system
-- made from the phone (someone nobody listed is named '+<digits>') or one
-- that contains the person's number.
CREATE OR REPLACE VIEW public.deal_room_roster WITH (security_barrier = true) AS
  SELECT p.id, p.room_id,
         CASE WHEN a.access = 'guest'
                   AND (NOT p.expected
                        OR (p.phone IS NOT NULL AND strpos(regexp_replace(p.display_name, '\D', '', 'g'), p.phone) > 0))
              THEN 'Unlisted number' || coalesce(' ending ' || right(p.phone, 2), '')
              ELSE p.display_name
         END AS display_name,
         p.role, p.status, p.joined_at, p.left_at
    FROM public.deal_room_participants p
   CROSS JOIN LATERAL (SELECT public.deal_room_access(p.room_id) AS access OFFSET 0) a
   WHERE a.access IS NOT NULL;

-- ---------- 7. Files: the private deal-files bucket ----------

INSERT INTO storage.buckets (id, name, public)
VALUES ('deal-files', 'deal-files', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- account-<id>/room-<room id>/… : staff who can see the room;
-- account-<id>/deal-<deal id>/… : whoever deals RLS shows the deal to.
-- Runs as the caller, so the deals lookup is filtered by deals RLS.
CREATE OR REPLACE FUNCTION public.deal_files_storage_can_read(p_name text)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  m text[] := regexp_match(coalesce(p_name, ''),
    '^account-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(room|deal)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.+$',
    'i');
BEGIN
  IF m IS NULL OR public.current_account_id() IS DISTINCT FROM m[1]::uuid THEN
    RETURN false;
  END IF;
  IF lower(m[2]) = 'room' THEN
    RETURN coalesce(public.deal_room_access(m[3]::uuid) IN ('supervisor','staff')
                    AND EXISTS (SELECT 1 FROM public.deal_rooms r WHERE r.id = m[3]::uuid AND r.account_id = m[1]::uuid),
                    false);
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.deals d WHERE d.id = m[3]::uuid AND d.account_id = m[1]::uuid);
END $$;

DROP POLICY IF EXISTS "Deal staff can read deal files" ON storage.objects;
CREATE POLICY "Deal staff can read deal files" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'deal-files' AND public.deal_files_storage_can_read(name));
-- No INSERT / UPDATE / DELETE policy: only the service role writes.

-- ---------- 8. Row-level security (reads; writes go through the functions) ----------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_guest_policies','deal_rooms','participant_consents','deal_room_participants',
    'deal_room_join_requests','group_messages','group_message_receipts','deal_files','deal_room_audit','deal_room_settings']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
  -- staff of the room only: never a guest
  FOREACH t IN ARRAY ARRAY['participant_consents','deal_room_participants','deal_room_join_requests','deal_room_audit']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated '
                   'USING (public.deal_room_access(room_id) IN (''supervisor'',''staff''))', t || '_read', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS deal_rooms_read ON public.deal_rooms;
CREATE POLICY deal_rooms_read ON public.deal_rooms
  FOR SELECT TO authenticated USING (public.deal_room_access(id) IS NOT NULL);

DROP POLICY IF EXISTS group_messages_read ON public.group_messages;
CREATE POLICY group_messages_read ON public.group_messages
  FOR SELECT TO authenticated USING (created_at >= public.deal_room_visible_since(room_id));

DROP POLICY IF EXISTS group_message_receipts_read ON public.group_message_receipts;
CREATE POLICY group_message_receipts_read ON public.group_message_receipts
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.group_messages g
                  WHERE g.id = message_id AND g.created_at >= public.deal_room_visible_since(g.room_id)));

-- a room's files: its staff; a deal's files: whoever deals RLS shows it to
DROP POLICY IF EXISTS deal_files_read ON public.deal_files;
CREATE POLICY deal_files_read ON public.deal_files
  FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND ((room_id IS NOT NULL AND public.deal_room_access(room_id) IN ('supervisor','staff'))
              OR (deal_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.deals d WHERE d.id = deal_files.deal_id))));

DROP POLICY IF EXISTS bank_guest_policies_read ON public.bank_guest_policies;
CREATE POLICY bank_guest_policies_read ON public.bank_guest_policies
  FOR SELECT TO authenticated USING (account_id = (SELECT public.current_account_id()));
DROP POLICY IF EXISTS bank_guest_policies_insert ON public.bank_guest_policies;
CREATE POLICY bank_guest_policies_insert ON public.bank_guest_policies
  FOR INSERT TO authenticated
  WITH CHECK (account_id = (SELECT public.current_account_id()) AND (SELECT public.current_role_rank()) >= 4);
DROP POLICY IF EXISTS bank_guest_policies_update ON public.bank_guest_policies;
CREATE POLICY bank_guest_policies_update ON public.bank_guest_policies
  FOR UPDATE TO authenticated
  USING (account_id = (SELECT public.current_account_id()) AND (SELECT public.current_role_rank()) >= 4)
  WITH CHECK (account_id = (SELECT public.current_account_id()) AND (SELECT public.current_role_rank()) >= 4);
DROP POLICY IF EXISTS bank_guest_policies_delete ON public.bank_guest_policies;
CREATE POLICY bank_guest_policies_delete ON public.bank_guest_policies
  FOR DELETE TO authenticated
  USING (account_id = (SELECT public.current_account_id()) AND (SELECT public.current_role_rank()) >= 4);

-- the group-invite template: members read it, admins write it
DROP POLICY IF EXISTS deal_room_settings_read ON public.deal_room_settings;
CREATE POLICY deal_room_settings_read ON public.deal_room_settings
  FOR SELECT TO authenticated USING (account_id = (SELECT public.current_account_id()));
DROP POLICY IF EXISTS deal_room_settings_insert ON public.deal_room_settings;
CREATE POLICY deal_room_settings_insert ON public.deal_room_settings
  FOR INSERT TO authenticated
  WITH CHECK (account_id = (SELECT public.current_account_id()) AND (SELECT public.current_role_rank()) >= 4);
DROP POLICY IF EXISTS deal_room_settings_update ON public.deal_room_settings;
CREATE POLICY deal_room_settings_update ON public.deal_room_settings
  FOR UPDATE TO authenticated
  USING (account_id = (SELECT public.current_account_id()) AND (SELECT public.current_role_rank()) >= 4)
  WITH CHECK (account_id = (SELECT public.current_account_id()) AND (SELECT public.current_role_rank()) >= 4);
DROP POLICY IF EXISTS deal_room_settings_delete ON public.deal_room_settings;
CREATE POLICY deal_room_settings_delete ON public.deal_room_settings
  FOR DELETE TO authenticated
  USING (account_id = (SELECT public.current_account_id()) AND (SELECT public.current_role_rank()) >= 4);

-- ---------- 9. Realtime ----------

DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['group_messages','deal_rooms','deal_room_participants','deal_room_join_requests']
    LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END $$;

-- ---------- 10. Privileges ----------
-- Supabase grants ALL on new tables and EXECUTE on new functions to
-- anon / authenticated / service_role (and EXECUTE to PUBLIC): revoke
-- everything, then grant the minimum.

REVOKE ALL ON public.bank_guest_policies, public.deal_rooms, public.participant_consents,
  public.deal_room_participants, public.deal_room_join_requests, public.group_messages,
  public.group_message_receipts, public.deal_files, public.deal_room_audit, public.deal_room_roster,
  public.deal_room_settings
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON public.bank_guest_policies, public.participant_consents, public.deal_room_participants,
  public.deal_room_join_requests, public.deal_files, public.deal_room_audit, public.deal_room_roster,
  public.deal_room_settings
  TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.bank_guest_policies, public.deal_room_settings TO authenticated;
-- every column but the invite link (a bearer secret: the server hands it out)
GRANT SELECT (id, account_id, channel_id, contact_id, deal_id, whatsapp_config_id, wa_group_id, create_request_id,
  subject, description, join_approval_mode, status, participant_count, window_until, created_by, created_at,
  opened_at, closed_at, close_reason, last_error) ON public.deal_rooms TO authenticated;
-- no WhatsApp ids: guests read these rows too; staff resolve people by participant id
GRANT SELECT (id, room_id, account_id, wa_message_id, direction, sender_participant_id, staff_user_id, type, body,
  media, template_name, status, error, category, recipients_billed, created_at) ON public.group_messages TO authenticated;
GRANT SELECT (message_id, participant_id, status, at) ON public.group_message_receipts TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bank_guest_policies, public.deal_rooms, public.participant_consents,
  public.deal_room_participants, public.deal_room_join_requests, public.group_messages,
  public.group_message_receipts, public.deal_files, public.deal_room_audit, public.deal_room_settings
  TO service_role;

DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('deal_room_append_only','deal_rooms_guard','deal_room_leader_sees','deal_room_access','deal_room_visible_since','deal_room_is_staff',
                'deal_room_can_manage','deal_room_can_post','deal_room_assert_service','deal_room_find_participant',
                'deal_room_add_unlisted','deal_room_refresh_count','deal_room_create','deal_room_approve_participant',
                'deal_room_add_staff','deal_room_add_guest_user','deal_room_mark_requested','deal_room_group_created',
                'deal_room_set_status','deal_room_record_join_request','deal_room_participant_event',
                'deal_room_record_message','deal_room_record_receipt','deal_files_storage_can_read')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
END $$;

-- authenticated: the client API, plus the helpers RLS, the roster view
-- and the storage policy call.
GRANT EXECUTE ON FUNCTION
  public.deal_room_create(uuid, uuid, uuid, text, text, jsonb, jsonb),
  public.deal_room_can_manage(uuid), public.deal_room_can_post(uuid),
  public.deal_room_approve_participant(uuid, boolean),
  public.deal_room_add_staff(uuid, uuid[]), public.deal_room_add_guest_user(uuid, uuid),
  public.deal_room_access(uuid), public.deal_room_visible_since(uuid), public.deal_files_storage_can_read(text)
  TO authenticated;

-- service_role: the Meta client and the webhooks.
GRANT EXECUTE ON FUNCTION
  public.deal_room_mark_requested(uuid, text),
  public.deal_room_group_created(text, text, text),
  public.deal_room_set_status(uuid, text, text),
  public.deal_room_record_join_request(text, text, text),
  public.deal_room_participant_event(text, text, text),
  public.deal_room_record_message(text, text, text, text, text, text, jsonb, text, uuid, text, text),
  public.deal_room_record_receipt(text, text, text)
  TO service_role;
