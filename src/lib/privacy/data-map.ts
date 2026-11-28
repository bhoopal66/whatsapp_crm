/**
 * The PDPL data map (UAE Federal Decree-Law 45/2021), port of package
 * 033h fitted to this schema. Every table a migration creates is in
 * exactly one of PERSONAL (holds data about a customer: a person outside
 * the staff) or NOT_PERSONAL; `data-map.test.ts` parses
 * supabase/migrations and fails on a table in neither.
 *
 * For each personal table:
 *   link    how a customer's rows are found (contact = contacts.id,
 *           conversation / case / deal / … = through that parent's
 *           contact, phone = a number equal to one of the contact's,
 *           scope = memory / vault subject, desk = a desk company)
 *   class   identifier | content | special (identity documents, KYC)
 *   erase   delete | anonymise | retain (with `retain`, a reason)
 *   exported  whether privacy_subject_export includes it
 *
 * The SQL of migrations 221 (export) and 222 (erase) implements this
 * map, plus, from 229 on, the functions a migration registers in
 * `privacy_extensions` (221 and 222 call every one); `data-map.test.ts`
 * checks they name every table the map says they cover.
 * docs/privacy.md is the operator contract.
 */

export type Link =
  | 'contact'
  | 'conversation'
  | 'message'
  | 'case'
  | 'submission_group'
  | 'deal'
  | 'deal_room'
  | 'whatsapp_group'
  | 'call'
  | 'flow_run'
  | 'journey_file'
  | 'brain_item'
  | 'phone'
  | 'scope'
  | 'desk';

export type DataClass = 'identifier' | 'content' | 'special';
export type EraseAction = 'delete' | 'anonymise' | 'retain';

export interface PersonalTable {
  link: Link;
  class: DataClass;
  erase: EraseAction;
  /** Why a table is kept (erase 'retain') or left out of the export. */
  reason?: string;
  exported: boolean;
}

const KYC =
  'KYC/AML and bank case record: kept under Federal Decree-Law 20/2018 and CBUAE rules until counsel says otherwise';
const CONSENT = 'proof of consent or opt-out: kept so the decision is honoured';
const AUDIT = 'audit trail: kept, holds no message text';

export const PERSONAL: Readonly<Record<string, PersonalTable>> = {
  // The customer and their chats
  contacts: {
    link: 'contact',
    class: 'identifier',
    erase: 'anonymise',
    exported: true,
    reason:
      'the row stays (as "Erased customer") so cases and consent keep their reference',
  },
  contact_custom_values: {
    link: 'contact',
    class: 'content',
    erase: 'delete',
    exported: true,
  },
  contact_notes: {
    link: 'contact',
    class: 'content',
    erase: 'delete',
    exported: true,
  },
  contact_tags: {
    link: 'contact',
    class: 'content',
    erase: 'delete',
    exported: true,
  },
  contact_consent_events: {
    link: 'contact',
    class: 'identifier',
    erase: 'retain',
    reason: CONSENT,
    exported: true,
  },
  contact_suppressions: {
    link: 'phone',
    class: 'identifier',
    erase: 'anonymise',
    reason:
      'opt-outs of numbers whose contact is gone, by keyed hash, and of numbers a contact left (contact_id): the erase drops who deleted it and whose it was, and keeps the hash and dates',
    exported: true,
  },
  conversations: {
    link: 'contact',
    class: 'content',
    erase: 'anonymise',
    exported: true,
  },
  messages: {
    link: 'conversation',
    class: 'content',
    erase: 'delete',
    exported: true,
  },
  message_reactions: {
    link: 'conversation',
    class: 'content',
    erase: 'delete',
    exported: false,
    reason: 'emoji only',
  },
  message_translations: {
    link: 'conversation',
    class: 'content',
    erase: 'delete',
    exported: true,
  },
  message_reminder_suggestions: {
    link: 'conversation',
    class: 'content',
    erase: 'delete',
    exported: false,
    reason: 'derived from messages',
  },
  conversation_events: {
    link: 'conversation',
    class: 'content',
    erase: 'delete',
    exported: true,
  },
  // Team notes inside the chat (241): erased and exported through
  // privacy_extensions.
  conversation_notes: {
    link: 'conversation',
    class: 'content',
    erase: 'delete',
    exported: true,
  },
  conversation_insight_events: {
    link: 'conversation',
    class: 'content',
    erase: 'delete',
    exported: false,
    reason: 'derived from messages',
  },
  conversation_coordinator_shares: {
    link: 'conversation',
    class: 'identifier',
    erase: 'delete',
    exported: false,
    reason: 'staff access grant',
  },
  compose_check_events: {
    link: 'conversation',
    class: 'content',
    erase: 'delete',
    exported: false,
    reason: 'staff draft check codes',
  },
  ai_reply_events: {
    link: 'conversation',
    class: 'content',
    erase: 'delete',
    exported: false,
    reason: 'bot outcome codes',
  },
  ai_usage_log: {
    link: 'conversation',
    class: 'identifier',
    erase: 'anonymise',
    exported: false,
    reason: 'token counts for billing; the conversation link is cleared',
  },
  ai_knowledge_gaps: {
    link: 'conversation',
    class: 'content',
    erase: 'delete',
    exported: true,
  },
  ts_decision_log: {
    link: 'contact',
    class: 'content',
    erase: 'anonymise',
    exported: false,
    reason:
      'hashed safety-check log, append-only: the person is taken out of it (063, 262)',
  },
  notifications: {
    link: 'contact',
    class: 'content',
    erase: 'delete',
    exported: false,
    reason: 'staff bells',
  },
  push_outbox: {
    link: 'conversation',
    class: 'content',
    erase: 'delete',
    exported: false,
    reason: 'staff push queue',
  },
  team_activity_blocks: {
    link: 'conversation',
    class: 'identifier',
    erase: 'retain',
    reason: AUDIT,
    exported: false,
  },
  team_activity_unlocks: {
    link: 'conversation',
    class: 'identifier',
    erase: 'retain',
    reason: AUDIT,
    exported: false,
  },
  automation_logs: {
    link: 'contact',
    class: 'identifier',
    erase: 'delete',
    exported: false,
    reason: 'rule run log',
  },
  automation_pending_executions: {
    link: 'contact',
    class: 'content',
    erase: 'delete',
    exported: false,
    reason: 'queued steps',
  },
  broadcast_recipients: {
    link: 'contact',
    class: 'identifier',
    erase: 'anonymise',
    exported: true,
  },
  // An unsent draft's wizard state may hold a CSV audience (phones,
  // names): 256's privacy_extensions hooks export the matching rows and
  // delete the draft state.
  broadcast_drafts: {
    link: 'phone',
    class: 'identifier',
    erase: 'delete',
    exported: true,
  },
  flow_runs: {
    link: 'contact',
    class: 'content',
    erase: 'delete',
    exported: true,
  },
  flow_run_events: {
    link: 'flow_run',
    class: 'content',
    erase: 'delete',
    exported: false,
    reason: 'derived from the run',
  },
  journey_files: {
    link: 'contact',
    class: 'content',
    erase: 'delete',
    exported: true,
  },
  journey_outbox: {
    link: 'journey_file',
    class: 'content',
    erase: 'delete',
    exported: false,
    reason: 'derived from the journey file',
  },
  journey_processed_events: {
    link: 'journey_file',
    class: 'identifier',
    erase: 'delete',
    exported: false,
    reason: 'event ids',
  },
  journey_optin_claims: {
    link: 'contact',
    class: 'identifier',
    erase: 'retain',
    reason: CONSENT,
    exported: true,
  },
  tasks: { link: 'contact', class: 'content', erase: 'delete', exported: true },
  callback_requests: {
    link: 'contact',
    class: 'identifier',
    erase: 'delete',
    exported: true,
  },
  deals: {
    link: 'contact',
    class: 'content',
    erase: 'anonymise',
    exported: true,
    reason:
      'the pipeline row stays (title and notes cleared) so deal rooms and reports keep their reference',
  },
  deal_files: {
    link: 'deal',
    class: 'special',
    erase: 'delete',
    exported: true,
  },
  compass_contacts: {
    link: 'contact',
    class: 'identifier',
    erase: 'anonymise',
    exported: true,
  },
  compass_notifications: {
    link: 'contact',
    class: 'content',
    erase: 'anonymise',
    exported: true,
  },
  // 315: queued events, and delivered ones for 7 days: an opt-out carries
  // the number, a lead the contact.
  webhook_event_outbox: {
    link: 'contact',
    class: 'identifier',
    erase: 'delete',
    exported: true,
  },
  // 305: ids and a hash of the request, 30 days; also goes with its message.
  // A broadcast's key names no contact.
  v1_message_keys: {
    link: 'contact',
    class: 'identifier',
    erase: 'delete',
    exported: true,
  },
  personal_history_import_chats: {
    link: 'phone',
    class: 'identifier',
    erase: 'retain',
    reason:
      "import progress of a staff member's personal number; holds a chat id, no messages",
    exported: false,
  },
  // Calls
  calls: {
    link: 'contact',
    class: 'content',
    erase: 'anonymise',
    exported: true,
  },
  call_live: {
    link: 'contact',
    class: 'identifier',
    erase: 'delete',
    exported: false,
    reason: 'live state, minutes long',
  },
  call_recordings: {
    link: 'call',
    class: 'content',
    erase: 'delete',
    exported: true,
  },
  call_access_log: {
    link: 'call',
    class: 'identifier',
    erase: 'retain',
    reason: AUDIT,
    exported: false,
  },
  pbx_audit: {
    link: 'contact',
    class: 'identifier',
    erase: 'retain',
    reason: AUDIT,
    exported: false,
  },
  // Documents
  customer_doc_folders: {
    link: 'contact',
    class: 'identifier',
    erase: 'retain',
    reason: KYC,
    exported: true,
  },
  customer_documents: {
    link: 'contact',
    class: 'special',
    erase: 'delete',
    exported: true,
    reason: 'a document filed to a case is kept with the case (KYC)',
  },
  // Cases (KYC/AML: kept)
  cases: {
    link: 'contact',
    class: 'special',
    erase: 'retain',
    reason: KYC,
    exported: true,
  },
  case_stage_history: {
    link: 'case',
    class: 'content',
    erase: 'retain',
    reason: KYC,
    exported: true,
  },
  case_notes: {
    link: 'case',
    class: 'content',
    erase: 'retain',
    reason: KYC,
    exported: true,
  },
  case_documents: {
    link: 'case',
    class: 'special',
    erase: 'retain',
    reason: KYC,
    exported: true,
  },
  case_doc_requests: {
    link: 'case',
    class: 'identifier',
    erase: 'retain',
    reason: AUDIT,
    exported: false,
  },
  case_document_files: {
    link: 'case',
    class: 'special',
    erase: 'retain',
    reason: KYC,
    exported: true,
  },
  case_outcome_reasons: {
    link: 'case',
    class: 'content',
    erase: 'retain',
    reason: KYC,
    exported: true,
  },
  case_bank_contacts: {
    link: 'case',
    class: 'content',
    erase: 'retain',
    reason: KYC,
    exported: true,
  },
  case_tasks: {
    link: 'case',
    class: 'content',
    erase: 'retain',
    reason: KYC,
    exported: true,
  },
  case_intake_prompts: {
    link: 'case',
    class: 'content',
    erase: 'retain',
    reason: KYC,
    exported: false,
  },
  case_detail_log: {
    link: 'case',
    class: 'content',
    erase: 'retain',
    reason: KYC,
    exported: false,
  },
  case_reassign_history: {
    link: 'case',
    class: 'identifier',
    erase: 'retain',
    reason: KYC,
    exported: false,
  },
  case_file_builds: {
    link: 'case',
    class: 'special',
    erase: 'retain',
    reason: KYC,
    exported: false,
  },
  case_file_build_reservations: {
    link: 'case',
    class: 'identifier',
    erase: 'retain',
    reason: KYC,
    exported: false,
  },
  case_file_downloads: {
    link: 'case',
    class: 'identifier',
    erase: 'retain',
    reason: AUDIT,
    exported: false,
  },
  case_file_ready_marks: {
    link: 'case',
    class: 'identifier',
    erase: 'retain',
    reason: KYC,
    exported: false,
  },
  case_macro_log: {
    link: 'case',
    class: 'identifier',
    erase: 'retain',
    reason: AUDIT,
    exported: false,
  },
  case_note_mentions: {
    link: 'case',
    class: 'identifier',
    erase: 'retain',
    reason: 'staff mentions',
    exported: false,
  },
  case_rule_runs: {
    link: 'case',
    class: 'identifier',
    erase: 'retain',
    reason: AUDIT,
    exported: false,
  },
  case_sla_state_log: {
    link: 'case',
    class: 'identifier',
    erase: 'retain',
    reason: KYC,
    exported: false,
  },
  case_sla_timers: {
    link: 'case',
    class: 'identifier',
    erase: 'retain',
    reason: KYC,
    exported: false,
  },
  case_snooze_log: {
    link: 'case',
    class: 'identifier',
    erase: 'retain',
    reason: AUDIT,
    exported: false,
  },
  case_takeover_log: {
    link: 'case',
    class: 'identifier',
    erase: 'retain',
    reason: AUDIT,
    exported: false,
  },
  case_task_status_log: {
    link: 'case',
    class: 'identifier',
    erase: 'retain',
    reason: AUDIT,
    exported: false,
  },
  case_view_audit: {
    link: 'case',
    class: 'identifier',
    erase: 'retain',
    reason: AUDIT,
    exported: false,
  },
  bank_ws_actions: {
    link: 'case',
    class: 'identifier',
    erase: 'retain',
    reason: KYC,
    exported: false,
  },
  bank_ws_posts: {
    link: 'case',
    class: 'content',
    erase: 'retain',
    reason: KYC,
    exported: false,
  },
  desk_customers: {
    link: 'desk',
    class: 'identifier',
    erase: 'retain',
    reason: KYC,
    exported: true,
  },
  desk_applications: {
    link: 'desk',
    class: 'identifier',
    erase: 'retain',
    reason: KYC,
    exported: true,
  },
  desk_customer_contacts: {
    link: 'contact',
    class: 'identifier',
    erase: 'retain',
    reason:
      'KYC: who acts for a company account (the contact row itself is anonymised)',
    exported: true,
  },
  desk_digest_outbox: {
    link: 'contact',
    class: 'content',
    erase: 'delete',
    exported: true,
  },
  desk_doc_consents: {
    link: 'desk',
    class: 'identifier',
    erase: 'retain',
    reason: CONSENT,
    exported: true,
  },
  // 248: who previewed which upload / tray document (ids and a time only)
  desk_file_previews: {
    link: 'case',
    class: 'identifier',
    erase: 'retain',
    reason: AUDIT,
    exported: false,
  },
  desk_tray: {
    link: 'contact',
    class: 'content',
    erase: 'delete',
    exported: true,
  },
  intake_items: {
    link: 'contact',
    class: 'special',
    erase: 'retain',
    reason: KYC,
    exported: true,
  },
  intake_item_events: {
    link: 'case',
    class: 'identifier',
    erase: 'retain',
    reason: AUDIT,
    exported: false,
  },
  // Submission groups (the case's WhatsApp group)
  submission_groups: {
    link: 'contact',
    class: 'identifier',
    erase: 'retain',
    reason: KYC,
    exported: true,
  },
  submission_group_messages: {
    link: 'submission_group',
    class: 'content',
    erase: 'retain',
    reason: KYC,
    exported: true,
  },
  submission_group_added_numbers: {
    link: 'submission_group',
    class: 'identifier',
    erase: 'retain',
    reason: KYC,
    exported: false,
  },
  submission_group_access: {
    link: 'submission_group',
    class: 'identifier',
    erase: 'retain',
    reason: 'staff access list',
    exported: false,
  },
  submission_group_reads: {
    link: 'submission_group',
    class: 'identifier',
    erase: 'retain',
    reason: 'staff read markers',
    exported: false,
  },
  submission_group_audit: {
    link: 'submission_group',
    class: 'identifier',
    erase: 'retain',
    reason: AUDIT,
    exported: false,
  },
  // Deal rooms and WhatsApp groups
  deal_rooms: {
    link: 'contact',
    class: 'identifier',
    erase: 'retain',
    reason:
      "the room is the deal's; its customer participants are erased below",
    exported: true,
  },
  deal_room_participants: {
    link: 'contact',
    class: 'identifier',
    erase: 'anonymise',
    exported: true,
  },
  deal_room_join_requests: {
    link: 'phone',
    class: 'identifier',
    erase: 'delete',
    exported: false,
    reason: 'join requests, minutes long',
  },
  participant_consents: {
    link: 'contact',
    class: 'identifier',
    erase: 'retain',
    reason: CONSENT,
    exported: true,
  },
  group_messages: {
    link: 'deal_room',
    class: 'content',
    erase: 'anonymise',
    exported: true,
    reason: "the customer participant's own messages are emptied",
  },
  group_message_receipts: {
    link: 'deal_room',
    class: 'identifier',
    erase: 'delete',
    exported: false,
    reason: 'read receipts',
  },
  whatsapp_group_participants: {
    link: 'contact',
    class: 'identifier',
    erase: 'anonymise',
    exported: true,
  },
  whatsapp_group_messages: {
    link: 'phone',
    class: 'content',
    erase: 'anonymise',
    exported: true,
  },
  whatsapp_message_costs: {
    link: 'phone',
    class: 'identifier',
    erase: 'anonymise',
    exported: false,
    reason: 'billing ledger; the recipient number is cleared',
  },
  // HR
  hr_conversations: {
    link: 'conversation',
    class: 'content',
    erase: 'delete',
    exported: true,
  },
  hr_stage_history: {
    link: 'conversation',
    class: 'content',
    erase: 'delete',
    exported: true,
  },
  hr_rule_fired: {
    link: 'conversation',
    class: 'identifier',
    erase: 'delete',
    exported: false,
    reason: 'rule ledger',
  },
  hr_agent_drafts: {
    link: 'conversation',
    class: 'content',
    erase: 'delete',
    exported: true,
  },
  hr_automsg_outbox: {
    link: 'contact',
    class: 'content',
    erase: 'anonymise',
    exported: true,
    reason: 'the row stays for the daily cap and dedupe; body cleared',
  },
  hr_automsg_consent: {
    link: 'contact',
    class: 'identifier',
    erase: 'retain',
    reason: CONSENT,
    exported: true,
  },
  // Memory, brain, vault
  memory_items: {
    link: 'scope',
    class: 'content',
    erase: 'delete',
    exported: true,
  },
  memory_acl: {
    link: 'scope',
    class: 'identifier',
    erase: 'anonymise',
    exported: false,
    reason: 'staff access grants: revoked, the rows stay (129)',
  },
  memory_audit: {
    link: 'scope',
    class: 'identifier',
    erase: 'retain',
    reason: AUDIT,
    exported: false,
  },
  brain_items: {
    link: 'contact',
    class: 'content',
    erase: 'delete',
    exported: true,
  },
  brain_embeddings: {
    link: 'brain_item',
    class: 'content',
    erase: 'delete',
    exported: false,
    reason: 'derived vectors',
  },
  brain_contact_marks: {
    link: 'contact',
    class: 'identifier',
    erase: 'retain',
    reason: 'keeps the customer out of the brain',
    exported: false,
  },
  brain_pages: {
    link: 'contact',
    class: 'content',
    erase: 'delete',
    exported: true,
  },
  vault_items: {
    link: 'scope',
    class: 'special',
    erase: 'delete',
    exported: true,
    reason:
      'listed by token and kind; values stay encrypted (no bulk decrypt path)',
  },
  vault_audit: {
    link: 'scope',
    class: 'identifier',
    erase: 'retain',
    reason: AUDIT,
    exported: false,
  },
  case_review_drafts: {
    link: 'case',
    class: 'content',
    erase: 'retain',
    reason: KYC,
    exported: false,
  },
  // Case CSAT (246): the rating requests and the customer's 1-5 ratings
  case_csat_requests: {
    link: 'contact',
    class: 'content',
    erase: 'delete',
    exported: true,
  },
  case_csat_responses: {
    link: 'contact',
    class: 'content',
    erase: 'delete',
    exported: true,
  },
  // PDPL itself
  privacy_legal_holds: {
    link: 'contact',
    class: 'identifier',
    erase: 'retain',
    reason: 'the legal hold is itself a legal record, kept after release',
    exported: false,
  },
  // Sales app
  taamul_sales_contacts: {
    link: 'phone',
    class: 'identifier',
    erase: 'anonymise',
    exported: true,
  },
  taamul_sales_events: {
    link: 'phone',
    class: 'identifier',
    erase: 'retain',
    exported: false,
    reason: 'event ids; the snapshot is in taamul_sales_contacts',
  },
};

/** Tables with no data about a customer, by kind. */
export const NOT_PERSONAL: Readonly<Record<string, string>> =
  Object.fromEntries(
    (
      [
        [
          'config',
          [
            'account_departments',
            'ai_configs',
            'ai_insight_settings',
            // 290: the learn-from-team-answers switch and its last run.
            'kb_learn_settings',
            'assignment_settings',
            'automations',
            'automation_steps',
            'bank_guest_policies',
            'case_account_settings',
            'case_bank_stages',
            'case_banks',
            'case_csat_settings',
            'case_doc_requirements',
            'case_file_specs',
            'case_intake_templates',
            'case_macros',
            'case_rules',
            'case_saved_views',
            'case_sla_config',
            'case_status_stage_map',
            'case_task_templates',
            'chat_dm_rules',
            'chat_role_permissions',
            'chat_tags',
            'chat_workspace_settings',
            'custom_fields',
            'deal_room_settings',
            'desk_bank_codes',
            'desk_digest_settings',
            'desk_number_seq',
            'desk_settings',
            'contact_suppression_keys',
            'privacy_extensions',
            'flow_nodes',
            'flows',
            'hr_agent_settings',
            'hr_automsg_settings',
            'hr_automsg_templates',
            'hr_automsg_triggers',
            'hr_line_settings',
            'hr_lines',
            'hr_workflow_rules',
            'journey_settings',
            'message_templates',
            'meta_protection_settings',
            'recycle_settings',
            'pbx_bank_numbers',
            'pbx_connections',
            'pbx_did_routes',
            'pbx_settings',
            'pipeline_stages',
            'pipelines',
            'quick_replies',
            'response_settings',
            'saved_views',
            'tags',
            'team_activity_new_chat_notice',
            'team_activity_settings',
            'ts_account_settings',
            'ts_policy',
            'whatsapp_config',
            'whatsapp_routes',
            'webhook_endpoints',
            'broadcasts',
            'kb_entries',
            'kb_imports',
            // 152: the label IS a customer's question (phone numbers and other
            // identifiers masked when the gap is stored, names not). No link to
            // a person, so neither export nor erase reaches it: an erased
            // customer's label goes with the next daily recompute.
            'kb_gap_topics',
            'kb_gap_topic_members',
            // 290: gap ids and a keyed hash (HMAC, secret not in the
            // database) of the topic's label per learned draft, and when a
            // gap was last looked at; no message text. Erasing a customer
            // deletes their gaps: the ids leave the ledger, and an
            // unapproved draft left with fewer than two chats is deleted
            // (trigger). An approved entry stays. The entry's question and
            // answers (kb_entries) are the model's, screened for known names
            // and identifiers; a name nobody saved, or a nickname, can still
            // be in one, which is why an admin must read every draft. 318
            // keeps the drafted English answer beside the ledger row (same
            // screening) and clears it when any of its gaps is deleted.
            'kb_learned_drafts',
            // 318: general rules distilled from admins' reviews; a CHECK refuses
            // e-mails, links, long numbers and redaction masks.
            'kb_learn_skills',
            'kb_learn_looks',
            'ai_knowledge_chunks',
            'ai_knowledge_documents',
            'ts_label',
            'whatsapp_market_prefix',
            'whatsapp_rate_card',
          ],
        ],
        [
          'staff',
          [
            'accounts',
            'account_invitations',
            'api_keys',
            'assignment_chat_limits',
            'assignment_rotation_state',
            'coordinator_banks',
            'coordinator_phones',
            'desk_bank_roles',
            'desk_leave',
            'hr_team_members',
            'member_presence',
            'pbx_extensions',
            'pbx_presence',
            'profiles',
            'push_preferences',
            'push_subscriptions',
            // 255: which staff member may open which report.
            'report_access',
            'team_members',
            'teams',
            'vault_roles',
            'whatsapp_channel_members',
            'whatsapp_channel_teams',
            'calendar_events',
            'calendar_event_attendees',
            'calendar_reminders_sent',
            'meetings',
            'meeting_invitees',
            'meeting_messages',
            'meeting_notes',
            'meeting_participants',
            'meeting_removed_users',
            'chat_channels',
            'chat_channel_members',
            'chat_channel_restrictions',
            'chat_channel_teams',
            'chat_notifications',
            'chat_typing',
            'chat_voice_plays',
            'internal_messages',
            'internal_message_edits',
            'internal_message_reactions',
            'message_attachments',
            'message_mentions',
            'message_mentions_broadcast',
            'message_pins',
            'saved_messages',
            'shared_calls',
            'shared_conversations',
            'bank_workspaces',
            'bank_ws_pins',
            'bank_ws_threads',
            'bank_ws_post_retractions',
            'personal_history_imports',
            'team_activity_alerts',
            'case_file_spec_audit',
            'case_intake_template_audit',
            'whatsapp_group_managers',
            'whatsapp_group_reads',
            'whatsapp_groups',
            'whatsapp_group_invites',
            'whatsapp_group_tombstones',
            // Staff voices and generic scripts ({name} / {company}
            // placeholders, never a customer's details): migration 242.
            'voice_note_subjects',
            'voice_note_entries',
            'web_lead_forms',
          ],
        ],
        [
          'system',
          [
            'assist_audit',
            'assist_pending_actions',
            'assist_rate_events',
            'brain_audit',
            'chat_audit_log',
            'deal_room_audit',
            'edge_auth_failures',
            'edge_auth_locks',
            'edge_rate_events',
            'edge_seen_keys',
            'hr_automsg_audit',
            'meta_health_events',
            'meta_number_state',
            'meta_template_health',
            'pbx_connection_secrets',
            'pbx_events_raw',
            // 264: inbound WhatsApp events waiting to be processed. Not
            // erased by contact: a row exists before any contact does,
            // so purge by age is the rule. The payload is emptied when
            // the event is done; a dead row goes after 14 days.
            'webhook_inbox',
            'workspace_audit',
            'privacy_requests',
            'privacy_retention_settings',
            // 237: which level rang whom per waiting episode (ids and
            // times only); goes with its chat (ON DELETE CASCADE).
            'response_escalations',
            // 321: which minute a time-based automation ran and how many
            // chats it touched (ids, times and counts only); goes with
            // its automation (ON DELETE CASCADE).
            'automation_schedule_runs',
            'case_review_queue',
            'ai_transfer_basis',
            'ai_transfer_log',
            // 255: the chat tag change log holds ids and a time only
            // (no text, no customer) and goes with its chat (ON DELETE
            // CASCADE); the meta row is the day the log began.
            'chat_tag_history',
            'chat_tag_history_meta',
            // 288: a staff login's new address, good for two minutes and
            // gone within a day. No customer.
            'login_email_permits',
          ],
        ],
      ] as const
    ).flatMap(([kind, tables]) => tables.map((t) => [t, kind]))
  );

export const ERASE_ACTIONS: readonly EraseAction[] = [
  'delete',
  'anonymise',
  'retain',
];
