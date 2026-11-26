/**
 * Which people and companies a text names (learn from team answers, 290).
 *
 * `buildNameMatcher` indexes an account's names once per run; matching
 * walks a text's words, so the cost does not grow with the list.
 *
 *  - whole words, any case; Arabic folded (alef/hamza, ta marbuta, alef
 *    maqsura, diacritics, tatweel), Latin accents too;
 *  - an Arabic word also matches behind و ف ب ل ك س and ال, in any
 *    combination (لمحمد, وأحمد, وبالنور);
 *  - a name of several words is matched as a phrase, and each of its
 *    words alone unless it is in COMMON (or shorter than three letters);
 *  - a legal suffix (LLC, L.L.C, FZE, ذ.م.م) is taken off and the core
 *    matched whatever suffix the text writes;
 *  - a core made only of COMMON words is matched as a phrase: three words
 *    or more, or two that brands are made of ("Golden Star"); a brand word
 *    and an ordinary one only where the text capitalises both;
 *  - a person's name that is also a word (May, Will, سيد) only with a
 *    capital that does not start a sentence, or beside another name;
 *  - a two-letter Latin name only where the text capitalises it;
 *  - spelling and script variants: joined or split (Abdul Rahman,
 *    AhmedKhan, D'Souza), softened vowels (Noor / Nour), a consonant
 *    skeleton with its vowel classes (Mohammed / Muhammad / محمد).
 *
 * What it cannot know: a name nobody saved, a nickname.
 *
 * Pure: the list itself is read in `learn-run.ts`.
 */

/** Words that name nobody on their own, and that answers are made of. */
const COMMON_TEXT = `
a an and are as at be by can do for from get go has have he hi how i if in
is it its me my no not of off on one or our out she so that the their them
they this to two up us was we what when where which who will with you your
all also any am pm yes ok okay sir madam dear hello thanks thank please mr
mrs ms miss dr eng al el abu bin ibn bint bu de la new old good best first
access account accounts accounting agency agent air application apply
approval approved area assets associates auto back bank banking banks bay
branch broker brokers building business businesses call capital car card
cards care case cash center centre chat check city clean cleaning clear
clearing client clients co commercial company companies complete confirm
consultancy consultant consultants consulting contact contracting
contractor contractors cooperation corporate corporation corp credit
customer customers customs daily date day days dead deal debit deposit
design development digital direct document documents draft drafting east
easy electrical electronics emirate emirates engineering enterprise
enterprises entry equipment est establishment event events every exchange
express facilities facility factory fast fee fees finance financial fit
fitness food foods foodstuff foundation free freelance freight full fund
furniture future garage gcc general gift global gold golden goods group
gulf hand health help here high holding holdings home hotel house import
export inc income industrial industries industry info information
insurance interest international internet into investment investments
invoice issue item jewellery job key kitchen land law lead legal letter
licence license licensed life light limit limited line link living llc llp
loan loans local logistics long ltd main maintenance make management
manager manufacturing marine market marketing materials max mechanical
media medical meeting merchant metal min minimum mobile money month
monthly months more mortgage motor motors must name national need net
network next north number offer office offices officer oil online only open
opening order other owner paper park partner partners party pay payment
payments permit person personal phone plan plus point pos post power price
private pro process product products professional project projects
promotion properties property provide public purchase quality quick rate
rates real reach receive recruitment renewal rental rent request required
restaurant retail review right royal safe salary sale sales salon school
sector secure security see send service services set share shipping shop
short sign site sky small smart sme soft software sole solution solutions
south special sports spare stamp standard star start state statement steel
stock store studio sub submit super supplies supply support swift system
systems tax team tech technical technologies technology terms test textile
time today top total tourism tourist trade trader traders trading training
transaction transfer transport transportation travel travels trust uae uk
unit united universal update usa value vat vehicle via view visa visit
wait want water way web week welcome west wholesale work workshop world
year years zone abu dhabi ajman dubai sharjah fujairah ras khaimah umm
quwain quwwain deira arab arabian arabia middle saudi india indian
pakistan pakistani oman qatar kuwait bahrain egypt english arabic islamic
islam january february march april may june july august september october
november december monday tuesday wednesday thursday friday saturday sunday
fze fzc fzco fzllc dmcc rakez ifza difc adgm jafza meydan psc pjsc spc
adcb fab enbd nbd mashreq rakbank hsbc wio adib nbf cbd cbi dib
و في من على الى عن ان هذا هذه هل لا نعم مع او كل قبل بعد عند لدى غير كم
ما ماذا كيف متى اين لو اذا تم يتم يمكن يمكنك لكم لك لي لنا هو هي نحن انت
الله اهلا مرحبا شكرا استاذ سيد سيدي الف مئه
شركه شركات مؤسسه مجموعه مكتب مكاتب تجاره تجاري تجاريه عامه عام خدمات خدمه
بنك بنوك مصرف حساب حسابات قرض قروض تمويل ائتمان بطاقه رخصه تصريح عمل حر
فتح طلب مستند مستندات وثيقه وثائق راتب دخل عميل عملاء فرع رقم هاتف رسوم
نقدي تحويل ايداع شهر شهري سنه سنوي يوم ايام اسبوع دبي ابوظبي ظبي الشارقه
شارقه عجمان راس خيمه فجيره ام قيوين امارات دوله دولي دوليه عالمي عربي
عربيه خليج مقاولات استشارات عقار عقارات نقل شحن سياحه سفر سيارات مطعم
مطاعم ذهب مواد بناء غذائيه صيانه تنظيف تسويق تقنيه تكنولوجيا حلول مشاريع
مشروع استثمار استثمارات قابضه محدوده ذمم ش م
`;

const ARABIC_LETTER = /[؀-ۿ]/u;

/** Case, accents, hamza seats, ta marbuta, tatweel and invisibles out. */
export function foldName(word: string): string {
  return word
    .normalize('NFKD')
    .replace(/[\p{M}\p{Cf}ـء'’ʼ`´]/gu, '')
    .toLowerCase()
    .replace(/ٱ/gu, 'ا')
    .replace(/[ىی]/gu, 'ي')
    .replace(/ک/gu, 'ك')
    .replace(/ة/gu, 'ه');
}

const COMMON: ReadonlySet<string> = new Set(
  COMMON_TEXT.split(/\s+/u).filter(Boolean).map(foldName)
);

// Letters, their marks and invisible joiners; digits and punctuation part.
const WORD = /[\p{L}\p{M}\p{Cf}ـ]+(?:['’ʼ`´][\p{L}\p{M}]+)*/gu;
/** Our own masks: never read as words, so masking twice changes nothing. */
const MASK =
  /\[(?:NAME|CASE|ID|EMAIL|IBAN|EID|CARD|OTP|ACCT|PASSPORT|LINK|PHONE:\d{3}|withheld)\]/gu;
/** Joined to the next word when written as one (Abdulrahman, عبدالله). */
const JOINERS = new Set(
  'عبد ابو ال abdul abdel abd abu al el d o mc mac bin ben bu'.split(' ')
);
const PREFIX = /^(?:[وفبلكس]{0,3}(?:ال)?|[وف]?لل)/u;

/** The word as a name could be written: itself, and behind each Arabic
 *  prefix it may carry. */
function forms(folded: string): string[] {
  const out = [folded];
  if (!ARABIC_LETTER.test(folded)) return out;
  const called = /^[وف]?يا/u.exec(folded)?.[0].length ?? 0;
  if (called && folded.length - called >= 2) out.push(folded.slice(called));

  const longest = PREFIX.exec(folded)?.[0].length ?? 0;
  for (let n = 1; n <= Math.max(longest, folded.startsWith('لل') ? 2 : 0); n++)
    if (folded.length - n >= 2) out.push(folded.slice(n));
  return out;
}

/** A word's pieces: split where a capital follows a small letter
 *  (AhmedKhan), a possessive or contraction ending taken off. */
function pieces(raw: string): { at: number; text: string }[] {
  const body = raw.replace(/['’ʼ`´](?:s|t|ll|re|ve|d|m)$/iu, '');
  const out: { at: number; text: string }[] = [];
  let at = 0;
  for (const m of body.matchAll(/(?<=\p{Ll})(?=\p{Lu})/gu)) {
    out.push({ at, text: body.slice(at, m.index) });
    at = m.index;
  }
  out.push({ at, text: body.slice(at) });
  return out;
}

const words = (text: string): string[] =>
  (text.match(WORD) ?? [])
    .flatMap((w) => pieces(w).map((p) => foldName(p.text)))
    .filter(Boolean);

// A legal form, whatever its dots and spaces.
const SUFFIX =
  '(?:l\\.?\\s?l\\.?\\s?c|f\\.?\\s?z\\.?[\\s-]?l\\.?l\\.?c|f\\.?z\\.?(?:e|c\\.?o|c)|d\\.?m\\.?c\\.?c|l\\.?l\\.?p|p\\.?(?:j\\.?)?s\\.?c|est|ltd|limited|inc|corp|plc|w\\.?l\\.?l|ش\\.?\\s?ذ\\.?\\s?م\\.?\\s?م|ذ\\.?\\s?م\\.?\\s?م|ش\\.?\\s?م\\.?\\s?[حعخ]|م\\.?\\s?م\\.?\\s?ح)';
const SUFFIX_AFTER = new RegExp(
  `^[\\s,.()-]{0,3}${SUFFIX}\\.?(?![\\p{L}\\p{N}])\\)?`,
  'iu'
);
const SUFFIX_END = new RegExp(`[\\s,.(-]+${SUFFIX}[.)\\s]*$`, 'iu');

const list = (text: string) => new Set(text.split(/\s+/u).filter(Boolean));
/** Ordinary words brands are made of; two of them are a name. */
const BRAND: ReadonlySet<string> = list(`
  access air best clean clear easy express fit future gold golden global gulf
  high light link max metal motor motors national north plus point power pro
  quality quick royal safe sky smart solution solutions south special star
  steel super swift system systems tech technologies top total trust united
  universal way west east world group
  ذهب خليج عالمي دولي دوليه عربي عربيه حلول تقنيه تكنولوجيا مشاريع`);
const bare = (w: string) => (w.startsWith('ال') ? w.slice(2) : w);
const isBrand = (w: string) => BRAND.has(w) || BRAND.has(bare(w));

/** People's names that are also words: masked only in a name's place. */
const GIVEN: ReadonlySet<string> = list(`
  max may will april june july august mark grace hope faith joy rose bill
  rich frank art jack pat guy dean grant chase miles king young summer dawn
  sunny price christian victor star gold noble pearl ruby crystal angel carol
  iris ivy olive drew rob sue gene
  سيد سفر امل كريم سلام جميل سعيد فرح هديه عادل رحمه`);
const MONTHS = list('may march april june july august');

/** One name in both scripts; short ones a skeleton cannot tell. */
const SAME_NAME = `omar umar عمر|ali aly علي|noor nour nur نور
  |hassan hasan حسن|fahad fahd فهد|hind هند|saad سعد|badr bader بدر|mai مي
  |huda hoda هدي|sara sarah ساره|maha مها|nada ندي|zaid zayed زيد زايد
  |saif سيف|ahmed ahmad احمد|abdullah abdallah abdulla عبدالله|lina لينا
  |khalid khaled خالد|ibrahim ebrahim ابراهيم|aisha ayesha aysha عايشه
  |abdulrahman abdelrahman abdurrahman عبدالرحمن|ismail ismael اسماعيل`
  .split('|')
  .map((g) => [...list(g)]);

/** Vowel spellings that sound alike, doubled letters once. */
const soft = (w: string) =>
  w
    .replace(/oo|ou|ow/gu, 'u')
    .replace(/ee|ei|ie/gu, 'i')
    .replace(/ph/gu, 'f')
    .replace(/q/gu, 'k')
    .replace(/y/gu, 'i')
    .replace(/(.)\1+/gu, '$1');

const AR_CONSONANT = new Map(
  'بb تt طt ثt جj حh هh خx دd ضd ذd زz ظz رr سs صs شS غg فf قk كk لl مm نn'
    .split(' ')
    .map((p) => [p[0]!, p[1]!] as const)
);
const LATIN_PAIR = new Map(
  'khx shS tht dhd ghg phf ckk chS'
    .split(' ')
    .map((p) => [p.slice(0, 2), p[2]!] as const)
);

interface Skeleton {
  /** Consonants, p and v apart. */
  key: string;
  /** The same with b / f for p / v: what Arabic can write. */
  cross: string;
  /** The vowel class after each consonant ('' = none written). */
  vowels: string[];
  arabic: boolean;
  length: number;
}
/** Consonants and vowel classes. Arabic writes long vowels only. */
function skeleton(word: string): Skeleton {
  const arabic = ARABIC_LETTER.test(word);
  const last = word.length - 1;
  let key = '';
  const vowels: string[] = [];
  let group = '';
  const flush = () => {
    if (key && group)
      vowels[key.length - 1] = /[uow]/u.test(group)
        ? 'u'
        : /[iey]/u.test(group)
          ? 'i'
          : 'a';
    group = '';
  };
  const add = (c: string) => {
    flush();
    if (key.at(-1) === c && !vowels[key.length - 1]) return;
    key += c;
    vowels[key.length - 1] = '';
  };
  for (let i = 0; i <= last; i++) {
    const ch = word[i]!;
    if (arabic) {
      const c = AR_CONSONANT.get(ch);
      if (i === 0 && 'اعوي'.includes(ch))
        add(ch === 'و' ? 'w' : ch === 'ي' ? 'y' : 'a');
      else if (ch === 'ا' || (ch === 'ه' && i === last)) group += 'a';
      else if (ch === 'و') group += 'u';
      else if (ch === 'ي') group += 'i';
      else if (c) add(c);
      continue;
    }
    const pair = LATIN_PAIR.get(word.slice(i, i + 2));
    if (i === 0 && /[aeiou]/u.test(ch)) add('a');
    else if (pair) {
      add(pair);
      i++;
    } else if (/[aeiou]/u.test(ch) || (i > 0 && /[wy]/u.test(ch))) group += ch;
    else if (ch === 'h' && i === last) continue;
    else if (/[a-z]/u.test(ch)) add(ch === 'c' || ch === 'q' ? 'k' : ch);
  }
  flush();
  const cross = key.replace(/p/gu, 'b').replace(/v/gu, 'f');
  return { key, cross, vowels, arabic, length: word.length };
}

/** A common word, also with its article (الشركة). No other prefix is
 *  taken off here: وسام would become ام. */
const isCommon = (folded: string) =>
  COMMON.has(folded) ||
  (folded.startsWith('ال') && COMMON.has(folded.slice(2)));

export interface NameMatcher {
  /** The text with every known name replaced by [NAME]. */
  mask(text: string): string;
}

/** A name, and whether it is a company's. Plain text may be either. */
export type KnownName = string | { name: string; kind: 'person' | 'company' };

interface Token {
  start: number;
  end: number;
  raw: string;
  forms: string[];
}
interface Phrase {
  words: string[];
  /** Only where the text capitalises it. */
  capitals: boolean;
}

export function buildNameMatcher(names: Iterable<KnownName>): NameMatcher {
  /** Names, or words of names, that identify on their own. */
  const single = new Set<string>();
  /** Two letters: Latin only where capitalised, Arabic whole words. */
  const short = new Set<string>();
  /** Saved names that are also words (GIVEN). */
  const given = new Set<string>();
  /** One ordinary word: a company only before its legal suffix. */
  const suffixed = new Set<string>();
  const softened = new Set<string>();
  const skeletons = new Map<string, Skeleton[]>();
  /** First word → the phrases it starts, longest first. */
  const phrases = new Map<string, Phrase[]>();

  const addOne = (w: string) => {
    if (single.has(w)) return;
    single.add(w);
    if (/^[a-z]{3,}$/u.test(w)) softened.add(soft(w));
    const k = skeleton(w);
    if (k.key.length < 2) return;
    const same = skeletons.get(k.cross);
    if (same) same.push(k);
    else skeletons.set(k.cross, [k]);
  };
  const addSingle = (w: string, person: boolean) => {
    if (GIVEN.has(w)) {
      if (person) given.add(w);
    } else if (!isCommon(w)) {
      if (w.length >= 3) addOne(w);
      else if (w.length === 2) short.add(w);
      const al = /^(?:ال.{3,}|al.{4,})$/u.test(w) ? w.slice(2) : '';
      if (al && !isCommon(al) && !GIVEN.has(al)) addOne(al);
    }
    if (!person) return;
    for (const same of SAME_NAME)
      if (same.includes(w) || same.includes(bare(w)))
        for (const g of same)
          if (g.length === 2) short.add(g);
          else if (!isCommon(g)) addOne(g);
  };
  const addPhrase = (w: string[], capitals = false) => {
    const same = phrases.get(w[0]!) ?? [];
    same.push({ words: w, capitals });
    phrases.set(w[0]!, same);
  };

  for (const entry of names) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (typeof name !== 'string') continue;
    const person = typeof entry === 'string' || entry.kind === 'person';
    let core = name.trim();
    let legal = false;
    for (let m = SUFFIX_END.exec(core); m; m = SUFFIX_END.exec(core)) {
      core = core.slice(0, m.index);
      legal = true;
    }
    const w = words(core);
    if (w.length === 0) continue;
    for (const x of w) addSingle(x, person);
    for (const m of core.match(WORD) ?? [])
      for (const part of m.split(/['’ʼ`´]/u).slice(1))
        if (part.length >= 3) addSingle(foldName(part), person);
    for (let i = 0; i + 1 < w.length; i++) {
      const joined = w[i]! + w[i + 1]!;
      const min = JOINERS.has(w[i]!) ? 4 : 6;
      const plain = isCommon(w[i]!) && isCommon(w[i + 1]!);
      if (joined.length >= min && !isCommon(joined) && (min === 4 || !plain))
        single.add(joined);
    }
    if (!w.every(isCommon)) {
      if (w.length >= 2) addPhrase(w);
      continue;
    }
    if (w.length === 1 && legal) suffixed.add(w[0]!);
    // "Golden Star" of "Golden Star Trading LLC", and the whole of it.
    for (let n = 2; n <= w.length; n++) {
      const brands = w.slice(0, 2).filter(isBrand).length;
      if (n === w.length && n >= 3) addPhrase(w);
      else if (brands === 2 || (person && w.some((x) => GIVEN.has(x))))
        addPhrase(w.slice(0, n));
      else if (brands === 1 && (legal || !person))
        addPhrase(w.slice(0, n), true);
    }
  }
  for (const same of phrases.values())
    same.sort((a, b) => b.words.length - a.words.length);
  const softCommon = new Set([...COMMON].map(soft));

  const similar = (t: Token, marked: boolean): boolean => {
    for (const f of t.forms) {
      if (f.length < 3 || isCommon(f) || GIVEN.has(f)) continue;
      const latin = /^[a-z]+$/u.test(f);
      if (latin && softened.has(soft(f)) && !softCommon.has(soft(f)))
        return true;
      const k = skeleton(f);
      for (const s of skeletons.get(k.cross) ?? []) {
        if (s.arabic !== k.arabic) {
          const [ar, la] = s.arabic ? [s, k] : [k, s];
          // Short Arabic words collide; SAME_NAME has the short names.
          if (ar.length < 4 || ar.key.length < 3) continue;
          const fits = ar.vowels.every(
            (v, i) => !v || i === ar.vowels.length - 1 || v === la.vowels[i]
          );
          if (fits) return true;
        } else if (latin && s.key === k.key) {
          const same = s.vowels.every((v, i) => v === k.vowels[i]);
          const first = s.vowels[0] === k.vowels[0];
          const n = k.key.length;
          if (n >= 4 && (marked || first) && Math.abs(s.length - k.length) <= 2)
            return true;
          if (n === 3 && (same || (marked && first))) return true;
          if (n === 2 && same && marked) return true;
        }
      }
    }
    return false;
  };

  const maskPlain = (text: string): string => {
    const tokens: Token[] = [];
    for (const m of text.matchAll(WORD))
      for (const p of pieces(m[0])) {
        const folded = foldName(p.text);
        if (!folded) continue;
        const parts = p.text
          .split(/['’ʼ`´]/u)
          .slice(1)
          .map(foldName);
        tokens.push({
          start: m.index + p.at,
          end: m.index + p.at + p.text.length,
          raw: p.text,
          forms: [...forms(folded), ...parts.filter((x) => x.length >= 3)],
        });
      }
    const gap = (i: number) =>
      text.slice(tokens[i]!.end, tokens[i + 1]?.start ?? text.length);
    const capital = (i: number) => /^\p{Lu}/u.test(tokens[i]?.raw ?? '');
    const shouted = (i: number) => /^\p{Lu}{2,}$/u.test(tokens[i]?.raw ?? '');
    /** A capital that says "name": not a sentence's first word, not one
     *  word of a shouted line. */
    const marked = (i: number) =>
      capital(i) &&
      i > 0 &&
      !/[.!?؟\n:]/u.test(gap(i - 1)) &&
      !(shouted(i) && (shouted(i - 1) || shouted(i + 1)));
    const near = (i: number) =>
      i >= 0 && i + 1 < tokens.length && /^[\s-]{0,2}$/u.test(gap(i));
    const strong = (i: number): boolean => {
      const t = tokens[i];
      if (!t) return false;
      return t.forms.some((f) => single.has(f)) || similar(t, marked(i));
    };
    const isGiven = (i: number) =>
      tokens[i]?.forms.some((f) => given.has(f)) === true;

    const matchAt = (at: number): number => {
      const t = tokens[at]!;
      const legalAfter = (n: number) =>
        SUFFIX_AFTER.test(text.slice(tokens[at + n - 1]!.end));
      for (const form of t.forms)
        for (const { words: w, capitals } of phrases.get(form) ?? [])
          if (
            w.every(
              (x, k) =>
                (k === 0 || tokens[at + k]?.forms.includes(x) === true) &&
                (!capitals || capital(at + k) || ARABIC_LETTER.test(x))
            )
          )
            return w.length;
      if (near(at)) {
        const b = tokens[at + 1]!.forms[0]!;
        const joiner = t.forms.some((f) => JOINERS.has(f));
        const plain = isCommon(t.forms[0]!) || isCommon(b);
        if (joiner || !plain) {
          const min = joiner ? 4 : 6;
          if (t.forms.some((f) => (f + b).length >= min && single.has(f + b)))
            return 2;
        }
        // "Abdul" and a hyphened article go with the name they precede.
        if (
          joiner &&
          (gap(at).includes('-') || /^(?:عبد|abd)/u.test(t.forms.at(-1)!)) &&
          strong(at + 1)
        )
          return 2;
      }
      if (strong(at)) return 1;
      if (suffixed.has(t.forms[0]!) && legalAfter(1)) return 1;
      if (isGiven(at)) {
        const beside = (other: number, join: number) =>
          near(join) &&
          (strong(other) || (isGiven(other) && capital(other) && capital(at)));
        if (beside(at + 1, at) || beside(at - 1, at - 1)) return 1;
        const month =
          MONTHS.has(t.forms[0]!) &&
          (/(?:\p{Nd}|(?<!\p{L})(?:in|on|since|until|last|next|early|late|mid))[\s-]*$/iu.test(
            text.slice(0, t.start)
          ) ||
            /^[\s,-]*\p{Nd}/u.test(text.slice(t.end)));
        if (marked(at) && !month) return 1;
      }
      const own = t.raw.startsWith('يا') ? t.forms : t.forms.slice(0, 1);
      if (
        own.some((f) => short.has(f) && (ARABIC_LETTER.test(f) || capital(at)))
      )
        return 1;
      return 0;
    };

    let out = '';
    let from = 0;
    for (let i = 0; i < tokens.length; i++) {
      const n = matchAt(i);
      if (n === 0) continue;
      out += text.slice(from, tokens[i]!.start) + '[NAME]';
      from = tokens[i + n - 1]!.end;
      const legal = SUFFIX_AFTER.exec(text.slice(from));
      if (legal) from += legal[0].length;
      i += n - 1;
      while (i + 1 < tokens.length && tokens[i + 1]!.start < from) i++;
    }
    return out + text.slice(from);
  };

  return {
    mask(text) {
      let out = '';
      let from = 0;
      for (const m of text.matchAll(MASK)) {
        out += maskPlain(text.slice(from, m.index)) + m[0];
        from = m.index + m[0].length;
      }
      return out + maskPlain(text.slice(from));
    },
  };
}
