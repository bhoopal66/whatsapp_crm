/**
 * Load Taamul bot-pack JSON into an account's AI agent, and run the
 * packs' test cases through the exact path the auto-reply bot uses.
 *
 *   npx tsx scripts/bot-pack.ts import <manifest.json | bot.json> <accountId>
 *   npx tsx scripts/bot-pack.ts test   <manifest.json | bot.json> <accountId> [caseId]
 *   npx tsx scripts/bot-pack.ts prompt <manifest.json | bot.json> <accountId>
 *
 * Given the manifest, every bot it lists is merged into ONE agent: the
 * shared brand, persona and guardrails once, then a section per product
 * line (scope, qualification order, product-specific flags), with every
 * FAQ and document checklist in the knowledge base. wacrm runs one AI
 * agent per account, and a customer replying to a campaign may ask
 * about any product, so one agent that can tell the four apart is the
 * shape that fits. Given a single bot file, that one product is loaded
 * alone.
 *
 * `import` writes `ai_configs.system_prompt` and replaces the account's
 * knowledge-base documents whose title starts with `[bot-pack]`. It never
 * touches `is_active` / `auto_reply_enabled` — going live is a decision
 * made in Agents → Setup, not by a script.
 *
 * `test` calls the model the same way `/api/ai/playground` does (KB
 * retrieval + system prompt + handoff sentinel) — no WhatsApp send, no
 * usage log — and checks each case's must_include / must_not_include /
 * handoff expectations.
 *
 * Reads `.env.local` for the Supabase + ENCRYPTION_KEY settings.
 */
import { config as loadEnv } from 'dotenv';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

loadEnv({ path: '.env.local' });

interface Faq {
  q: string;
  a: string;
}

interface QualificationField {
  field: string;
  question_en: string;
  question_ar: string;
}

interface HandoffTrigger {
  id: string;
  trigger: string;
  action: string;
}

interface BotPack {
  bot_id: string;
  product_line: string;
  display_name: string;
  scope: string;
  brand: {
    company: string;
    short: string;
    positioning: string;
    address: string;
    partner_banks: string[];
    contact_general: string;
    working_hours: string;
  };
  persona: {
    name?: string;
    role: string;
    tone: string;
    style_rules: string[];
    identity_disclosure_en: string;
    identity_disclosure_ar: string;
    addendum: string;
  };
  guardrails: { id: string; rule: string }[];
  qualification_fields: QualificationField[];
  /** Shape differs per product line; see `documentsDoc`. */
  documents: Record<string, string[] | string> | null;
  knowledge_base: {
    global_faq: Faq[];
    product_faq: Faq[];
    status_scripts?: Record<string, string>;
    red_flag_activities?: string[];
    pricing_policy?: Record<string, string>;
    soft_screen_rules?: { rule: string; outcome: string }[];
    lead_engine_rules?: Record<string, string[]>;
    product_catalogue?: {
      code: string;
      name: string;
      fit: string;
      typical_security: string;
    }[];
  };
  handoff_triggers: { common: HandoffTrigger[]; product: HandoffTrigger[] };
  test_cases: TestCase[];
}

interface Manifest {
  package: string;
  bots: { bot_id: string; file: string }[];
}

interface TestCase {
  id: string;
  input: string;
  handoff: boolean;
  must_include?: string[];
  must_not_include?: string[];
  expect_lang?: string;
  expect_tags?: string[];
  expect_trigger?: string;
}

const TITLE_PREFIX = '[bot-pack]';

/** Hard handoffs: the bot stops and a human takes the thread. */
const HARD_HANDOFF_IDS = new Set(['H01', 'H02', 'H04', 'H05', 'H08', 'H09']);

/**
 * Product-specific triggers the packs mark "tag + flag RM" but whose
 * own flow text says to keep qualifying (non-resident shareholder,
 * red-flag activity, bounced cheques, freelance permit, offshore or
 * layered ownership). Every other product trigger — large ticket,
 * dispute, distress, term-sheet talk, technical fault, pre-screen
 * complete — needs a person to act, and wacrm has no way to flag one
 * without handing the thread over, so those become real handoffs.
 */
const SOFT_PRODUCT_FLAGS = new Set([
  'H-AO1',
  'H-AO2',
  'H-AO4',
  'H-AO5',
  'H-BL2',
  'H-POS5',
]);

/**
 * Pack rules rewritten for a knowledge base that holds the real bank
 * package sheets. The pack's G03 ("never quote a fee or minimum
 * balance") predates that and made the model blur figures it had been
 * given — a customer asking "charges?" got "some packages show charges
 * from AED 99" instead of the two packages and their prices.
 */
const GUARDRAIL_OVERRIDES: Record<string, string> = {
  G03: "Quote fees, monthly charges, minimum balances, timelines and rates ONLY as they appear in the knowledge base, exactly as written there, and label them 'indicative, subject to the bank's confirmation'. Never invent, estimate or round a figure the knowledge base does not contain. When the knowledge base lists several packages, give each one with its figure — do not summarise them into a vague range.",
};

const HANDOFF_SCRIPT_EN =
  'Thank you — this needs a relationship manager. I have flagged your case; you will hear from us within working hours. Is there anything else I can clarify meanwhile?';
const HANDOFF_SCRIPT_AR =
  'شكراً لك — يتطلب هذا الأمر مدير علاقات. تم تحويل طلبك وسيتم التواصل معك خلال ساعات العمل. هل هناك ما يمكنني توضيحه في هذه الأثناء؟';

function loadPacks(file: string): BotPack[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Manifest | BotPack;
  if ('bots' in raw && Array.isArray(raw.bots)) {
    const dir = dirname(resolve(file));
    return raw.bots.map(
      (b) => JSON.parse(readFileSync(resolve(dir, b.file), 'utf8')) as BotPack
    );
  }
  return [raw as BotPack];
}

function shortName(pack: BotPack): string {
  return pack.display_name.replace(/^Taamul Assistant — /, '');
}

// ------------------------------------------------------------
// System prompt
// ------------------------------------------------------------

function productSection(pack: BotPack, index: number): string {
  const kb = pack.knowledge_base;
  const lines: string[] = [
    `=== ${index + 1}. ${shortName(pack)} (${pack.product_line}) ===`,
    `SCOPE: ${pack.scope}`,
    `CONSULTANT VOICE: ${pack.persona.addendum}`,
    // English only: with the Arabic wording of every question in the
    // prompt, the model answered some English messages in Arabic. It
    // translates the question itself when the customer writes Arabic.
    "QUALIFICATION ORDER (one question per turn, in this order; skip what the customer already told you; ask in the customer's language):",
    ...pack.qualification_fields.map(
      (q, i) => `${i + 1}. ${q.field}: '${q.question_en}'`
    ),
  ];
  const soft = pack.handoff_triggers.product.filter((h) =>
    SOFT_PRODUCT_FLAGS.has(h.id)
  );
  const hard = pack.handoff_triggers.product.filter(
    (h) => !SOFT_PRODUCT_FLAGS.has(h.id)
  );
  if (hard.length > 0) {
    lines.push(
      'PRODUCT HANDOFFS (answer or acknowledge in one or two lines, then the HANDOFF SCRIPT, then [[HANDOFF]]):',
      ...hard.map((h) => `- ${h.id}: ${h.trigger}`)
    );
  }
  if (soft.length > 0) {
    lines.push(
      'PRODUCT FLAGS (not handoffs — say a relationship manager will review that point, then keep going):',
      ...soft.map((h) => `- ${h.id}: ${h.trigger} → ${h.action}`)
    );
  }
  if (kb.red_flag_activities) {
    lines.push(
      `RED-FLAG ACTIVITIES (enhanced review, never a refusal): ${kb.red_flag_activities.join('; ')}.`
    );
  }
  if (kb.pricing_policy) {
    lines.push(
      'PRICING POLICY:',
      ...Object.entries(kb.pricing_policy).map(([k, v]) => `- ${k}: ${v}`)
    );
  }
  if (kb.soft_screen_rules) {
    lines.push(
      'SOFT-SCREEN RULES (apply as answers arrive; never decline):',
      ...kb.soft_screen_rules.map((r) => `- if ${r.rule}: ${r.outcome}`)
    );
  }
  if (kb.lead_engine_rules?.pre_approval_documents_only) {
    lines.push(
      'DOCUMENTS: at this stage ask ONLY for the pre-approval set (KYC, 12 months bank statements, VAT returns). Everything else is requested after pre-approval.'
    );
  }
  return lines.join('\n');
}

/**
 * One prompt for every product line. Built from the packs' structured
 * fields rather than their `system_prompt` strings: those were written
 * for a runtime that parses a JSON envelope and keeps an "RM inbox
 * flag" beside the reply, whereas wacrm's bot sends plain text and has
 * one handoff mechanism — the `[[HANDOFF]]` marker, which pauses the
 * bot and assigns the thread to a human.
 */
function buildSystemPrompt(packs: BotPack[]): string {
  const base = packs[0];
  const { brand, persona } = base;
  const hard = base.handoff_triggers.common.filter((h) =>
    HARD_HANDOFF_IDS.has(h.id)
  );

  const products =
    packs.length === 1
      ? `PRODUCT: ${base.display_name}.`
      : [
          `PRODUCT LINES: Taamul offers ${packs.length} products — ${packs
            .map(shortName)
            .join(', ')}.`,
          "Work out which one the customer wants from their message, or from the campaign they are replying to (see campaign context, if any). If it is not clear, ask one short question to find out. A customer can switch product mid-chat; then follow that product's section. Do not run two qualification sequences at once.",
        ].join('\n');

  return [
    `You are ${persona.name ?? 'Taamul Assistant'}, the WhatsApp virtual assistant of ${brand.company} (${brand.short}). You always reply in the language of the customer's most recent message — English to English, Arabic to Arabic.`,
    `${brand.short} is a ${brand.positioning}. Partner banks: ${brand.partner_banks.join(', ')}. ${brand.short} is NOT a bank. Office: ${brand.address}. Working hours: ${brand.working_hours}. General contact: ${brand.contact_general}.`,
    '',
    `ROLE: ${persona.role}.`,
    `TONE: ${persona.tone}`,
    'STYLE RULES:',
    ...persona.style_rules.map((r) =>
      r.startsWith('Max 4 short lines')
        ? '- Keep replies short — up to 4 lines for a normal turn. When the customer asks for details, packages, charges or a comparison, answer in full with a numbered list (one line per package: name, balance requirement, monthly charge, key benefit), then one closing question.'
        : `- ${r}`
    ),
    '',
    'HARD GUARDRAILS (never violate):',
    ...base.guardrails.map((g) => `- [${g.id}] ${GUARDRAIL_OVERRIDES[g.id] ?? g.rule}`),
    '',
    "WHAT YOU MAY DO: answer questions from the knowledge base; ask the qualification questions one at a time; summarise the customer's profile back to them; send document checklists; tell the customer a relationship manager will follow up.",
    'WHAT YOU MAY NOT DO: confirm approvals, submissions or term-sheet acceptance; quote firm rates, fees or prices; name which bank will approve; review documents; give legal, tax or investment advice; state or promise the status of an application (you cannot see it — a relationship manager gives status updates).',
    '',
    products,
    '',
    ...packs.map((p, i) => productSection(p, i) + '\n'),
    "HANDOFF TRIGGERS — when one fires, send the HANDOFF SCRIPT in the customer's language and end your output with [[HANDOFF]]; a relationship manager then takes over the thread:",
    ...hard.map((h) => `- ${h.id}: ${h.trigger}`),
    '- H03: you still cannot understand the request after 3 clarification attempts.',
    '- H06: the customer asks for the status of an existing application — you cannot see it.',
    '',
    `HANDOFF SCRIPT EN: '${HANDOFF_SCRIPT_EN}'`,
    `HANDOFF SCRIPT AR: '${HANDOFF_SCRIPT_AR}'`,
    '',
    `IDENTITY EN: ${persona.identity_disclosure_en}`,
    `IDENTITY AR: ${persona.identity_disclosure_ar}`,
    'Disclose your identity in your first reply of a conversation and whenever asked.',
    '',
    'OUTPUT FORMAT: plain WhatsApp message text only — never JSON, labels or metadata.',
    '',
    'HOW TO HAND OFF IN THIS SYSTEM:',
    '- Only the HANDOFF TRIGGERS and PRODUCT HANDOFFS end with [[HANDOFF]]. The PRODUCT FLAGS do not: keep the conversation going and continue qualification.',
    '- Never repeat a rate, percentage, price or fee the customer proposes, even to say it is wrong — say the figure is set by the bank or in the written offer.',
    '- Ordinary questions about documents, timelines, minimum balances, fees, pricing or which bank are answered from the knowledge base using indicative, bank-subject wording. They are not H05 — H05 is only when the customer pushes for a lower rate, fee or price after being told it is set by the bank or in the offer.',
    '- Also hand off when the knowledge base does not cover a factual question. Do not hand off a question the knowledge base answers.',
    '- Answer the question that was asked, with the specifics the knowledge base gives, BEFORE asking the next qualification question. Never replace an answer with a generic statement when the knowledge base has the facts.',
    '- Outside working hours, mention that a relationship manager will respond on the next business day.',
    '',
    "LANGUAGE — this rule wins over everything above: reply in the language of the customer's most recent message. An English message gets an English reply; an Arabic message gets an Arabic reply (Modern Standard Arabic, Gulf-neutral). Never mix the two languages in one reply.",
    '',
    'Questions about who Taamul is, whether it is a bank, how it is paid, or how it is regulated are answered from the positioning above and the General FAQ — they are not handoffs.',
  ].join('\n');
}

// ------------------------------------------------------------
// Knowledge base documents
// ------------------------------------------------------------

interface KbDoc {
  title: string;
  content: string;
}

function faqDoc(title: string, faqs: Faq[]): KbDoc {
  return {
    title,
    content: faqs.map((f) => `Q: ${f.q}\nA: ${f.a}`).join('\n\n'),
  };
}

/** The pack's document lists, whatever keys it uses, as one checklist. */
function documentsDoc(pack: BotPack): KbDoc | null {
  const docs = pack.documents ?? pack.knowledge_base.lead_engine_rules;
  if (!docs) return null;
  const LABELS: Record<string, string> = {
    core: 'Core documents (required for every application)',
    supporting: 'Supporting documents (depending on profile)',
    pre_approval_documents_only:
      'Pre-approval stage — the ONLY documents needed now',
    post_pre_approval_documents: 'Requested only after pre-approval',
    process: 'Process',
    pre_assessment: 'Pre-assessment documents',
    full_file: 'Full file (after pre-assessment)',
    transaction_level: 'Per-transaction documents',
  };
  const lines: string[] = [`Document checklist — ${shortName(pack)}`];
  for (const [key, value] of Object.entries(docs)) {
    if (Array.isArray(value)) {
      lines.push('', `${LABELS[key] ?? key}:`);
      lines.push(...value.map((d, i) => `${i + 1}. ${d}`));
    } else if (typeof value === 'string') {
      lines.push('', value);
    }
  }
  lines.push(
    '',
    'Documents are uploaded only via the secure link your relationship manager sends. Do not send documents in this chat.'
  );
  return {
    title: `${TITLE_PREFIX} ${shortName(pack)} — Document checklist`,
    content: lines.join('\n'),
  };
}

function packDocuments(packs: BotPack[]): KbDoc[] {
  const base = packs[0];
  const out: KbDoc[] = [
    faqDoc(`${TITLE_PREFIX} General FAQ`, base.knowledge_base.global_faq),
  ];
  for (const pack of packs) {
    const kb = pack.knowledge_base;
    out.push(
      faqDoc(`${TITLE_PREFIX} ${shortName(pack)} — FAQ`, kb.product_faq)
    );
    const docs = documentsDoc(pack);
    if (docs) out.push(docs);
    if (kb.product_catalogue) {
      out.push({
        title: `${TITLE_PREFIX} ${shortName(pack)} — Product catalogue`,
        content: kb.product_catalogue
          .map(
            (p) =>
              `${p.code} — ${p.name}\nBest fit: ${p.fit}\nTypical security: ${p.typical_security}`
          )
          .join('\n\n'),
      });
    }
  }
  if (base.knowledge_base.status_scripts) {
    out.push({
      title: `${TITLE_PREFIX} Application status replies`,
      content: [
        'When a customer asks for the status of their application, the relationship manager replies with the script for their current stage:',
        ...Object.entries(base.knowledge_base.status_scripts).map(
          ([k, v]) => `- ${k}: ${v}`
        ),
      ].join('\n'),
    });
  }
  return out;
}

// ------------------------------------------------------------
// Commands
// ------------------------------------------------------------

async function importPacks(packs: BotPack[], accountId: string) {
  const { supabaseAdmin } = await import('@/lib/ai/admin-client');
  const { loadAiConfig } = await import('@/lib/ai/config');
  const { ingestDocument } = await import('@/lib/ai/knowledge');
  const db = supabaseAdmin();

  const config = await loadAiConfig(db, accountId, { requireActive: false });
  if (!config)
    throw new Error(
      'No ai_configs row for this account — add a provider key in Agents → Setup first.'
    );

  const systemPrompt = buildSystemPrompt(packs);
  const { error: cfgErr } = await db
    .from('ai_configs')
    .update({ system_prompt: systemPrompt })
    .eq('account_id', accountId);
  if (cfgErr) throw cfgErr;
  console.log(
    `system prompt set (${systemPrompt.length} chars, ${packs.length} product line(s))`
  );

  // Replace, don't append — re-import must be idempotent.
  const { data: existing } = await db
    .from('ai_knowledge_documents')
    .select('id, title')
    .eq('account_id', accountId)
    .like('title', `${TITLE_PREFIX}%`);
  for (const row of existing ?? []) {
    await db.from('ai_knowledge_documents').delete().eq('id', row.id);
  }
  if (existing?.length)
    console.log(`removed ${existing.length} previous pack document(s)`);

  for (const doc of packDocuments(packs)) {
    const { data, error } = await db
      .from('ai_knowledge_documents')
      .insert({ account_id: accountId, title: doc.title, content: doc.content })
      .select('id')
      .single();
    if (error || !data) throw error ?? new Error('insert failed');
    await ingestDocument(db, accountId, config, data.id, doc.content);
    console.log(`kb: ${doc.title} (${doc.content.length} chars)`);
  }
}

function check(tc: TestCase, reply: string, handoff: boolean): string[] {
  const failures: string[] = [];
  const lower = reply.toLowerCase();
  // The pack's `handoff: true` covers both a hard handoff and a soft "flag
  // the RM but keep talking" (cases that only list `expect_tags`). Only
  // the hard ones map to wacrm's [[HANDOFF]].
  const expectHandoff = tc.handoff && !(tc.expect_tags && !tc.expect_trigger);
  if (expectHandoff !== handoff)
    failures.push(`handoff expected=${expectHandoff} got=${handoff}`);
  // On handoff the customer only sees the closing line, so content
  // checks apply to a real reply.
  if (!handoff) {
    for (const s of tc.must_include ?? []) {
      if (!lower.includes(s.toLowerCase())) failures.push(`missing "${s}"`);
    }
  }
  for (const s of tc.must_not_include ?? []) {
    if (lower.includes(s.toLowerCase())) failures.push(`contains "${s}"`);
  }
  if (tc.expect_lang === 'ar' && !/[؀-ۿ]/.test(reply) && !handoff) {
    failures.push('expected an Arabic reply');
  }
  return failures;
}

async function testPacks(packs: BotPack[], accountId: string, only?: string) {
  const { supabaseAdmin } = await import('@/lib/ai/admin-client');
  const { loadAiConfig } = await import('@/lib/ai/config');
  const { retrieveKnowledge } = await import('@/lib/ai/knowledge');
  const { buildSystemPrompt } = await import('@/lib/ai/defaults');
  const { generateReply } = await import('@/lib/ai/generate');
  const db = supabaseAdmin();

  const config = await loadAiConfig(db, accountId, { requireActive: false });
  if (!config) throw new Error('No ai_configs row for this account.');
  console.log(
    `model: ${config.provider}/${config.model}  active=${config.isActive}  auto-reply=${config.autoReplyEnabled}\n`
  );

  let passed = 0;
  let total = 0;
  for (const pack of packs) {
    const cases = only
      ? pack.test_cases.filter((t) => t.id === only)
      : pack.test_cases;
    if (cases.length === 0) continue;
    console.log(`--- ${pack.bot_id} ---\n`);
    for (const tc of cases) {
      total++;
      // "[image]" cases model a media message; the bot never sees those
      // (the pipeline only dispatches plain text), so describe it instead.
      const input = tc.input.replace(
        '[image]',
        '(customer attached a photo of the document)'
      );
      const messages = [{ role: 'user' as const, content: input }];
      const knowledge = await retrieveKnowledge(db, accountId, config, input);
      const systemPrompt = buildSystemPrompt({
        userPrompt: config.systemPrompt,
        mode: 'auto_reply',
        knowledge,
      });
      let reply = '';
      let handoff = false;
      try {
        const r = await generateReply({ config, systemPrompt, messages });
        reply = r.text;
        handoff = r.handoff;
      } catch (err) {
        console.log(`${tc.id}  ERROR  ${(err as Error).message}\n`);
        continue;
      }
      const failures = check(tc, reply, handoff);
      const ok = failures.length === 0;
      if (ok) passed++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${tc.id}  customer: ${tc.input}`);
      const shown = reply.replace(/\n/g, '\n           ');
      console.log(
        `      bot: ${shown}${handoff ? `${reply ? '\n           ' : ''}→ handed off to a human` : ''}`
      );
      if (!ok) console.log(`      ✗ ${failures.join('; ')}`);
      console.log();
    }
  }
  console.log(`${passed}/${total} passed`);
}

async function main() {
  const [cmd, file, accountId, only] = process.argv.slice(2);
  if (!cmd || !file || !accountId) {
    console.error(
      'usage: bot-pack.ts <import|test|prompt> <manifest.json | bot.json> <accountId> [caseId]'
    );
    process.exit(1);
  }
  const packs = loadPacks(file);
  console.log(
    `${packs.map((p) => p.bot_id).join(' + ')} → account ${accountId}\n`
  );
  if (cmd === 'import') await importPacks(packs, accountId);
  else if (cmd === 'test') await testPacks(packs, accountId, only);
  else if (cmd === 'prompt') console.log(buildSystemPrompt(packs));
  else throw new Error(`unknown command ${cmd}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
