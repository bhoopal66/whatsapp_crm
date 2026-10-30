/**
 * The team-chat emoji picker's data and pure helpers (no DOM, no I/O).
 *
 * A curated set of common emoji rather than the full Unicode list: no
 * picker package is installed, and a short list is quicker to scan.
 * Skin tones are left out on purpose.
 *
 * Names and keywords stay English in every locale: they are search
 * keywords, not UI copy, so they are not in messages/*.json.
 */

export const EMOJI_CATEGORIES = [
  'smileys',
  'gestures',
  'hearts',
  'objects',
  'nature',
  'travel',
  'flags',
] as const;
export type EmojiCategory = (typeof EMOJI_CATEGORIES)[number];

export interface EmojiEntry {
  emoji: string;
  name: string;
  keywords: readonly string[];
  category: EmojiCategory;
}

/** [emoji, name, space-separated keywords] per category. */
const RAW: Record<
  EmojiCategory,
  ReadonlyArray<readonly [string, string, string]>
> = {
  smileys: [
    ['😀', 'grinning face', 'smile happy'],
    ['😃', 'smiling face with big eyes', 'smile happy joy'],
    ['😄', 'smiling face with smiling eyes', 'smile happy laugh'],
    ['😁', 'beaming face', 'grin smile'],
    ['😆', 'grinning squinting face', 'laugh lol'],
    ['😅', 'grinning face with sweat', 'relief nervous'],
    ['🤣', 'rolling on the floor laughing', 'rofl lol laugh'],
    ['😂', 'face with tears of joy', 'laugh lol funny'],
    ['🙂', 'slightly smiling face', 'smile'],
    ['🙃', 'upside-down face', 'silly sarcasm'],
    ['😉', 'winking face', 'wink'],
    ['😊', 'smiling face with smiling eyes and blush', 'blush happy'],
    ['😇', 'smiling face with halo', 'angel innocent'],
    ['🥰', 'smiling face with hearts', 'love adore'],
    ['😍', 'heart eyes', 'love crush'],
    ['🤩', 'star-struck', 'wow amazing'],
    ['😘', 'face blowing a kiss', 'kiss love'],
    ['😋', 'face savoring food', 'yum tasty'],
    ['😛', 'face with tongue', 'tongue playful'],
    ['😜', 'winking face with tongue', 'crazy playful'],
    ['🤪', 'zany face', 'crazy goofy'],
    ['🤑', 'money-mouth face', 'money rich'],
    ['🤗', 'hugging face', 'hug thanks'],
    ['🤭', 'face with hand over mouth', 'oops giggle'],
    ['🤫', 'shushing face', 'quiet secret'],
    ['🤔', 'thinking face', 'think hmm'],
    ['🤐', 'zipper-mouth face', 'secret quiet'],
    ['🤨', 'face with raised eyebrow', 'suspicious doubt'],
    ['😐', 'neutral face', 'meh'],
    ['😑', 'expressionless face', 'blank'],
    ['😶', 'face without mouth', 'speechless'],
    ['😏', 'smirking face', 'smirk'],
    ['😒', 'unamused face', 'meh annoyed'],
    ['🙄', 'face with rolling eyes', 'eyeroll'],
    ['😬', 'grimacing face', 'awkward'],
    ['😌', 'relieved face', 'relief calm'],
    ['😔', 'pensive face', 'sad'],
    ['😪', 'sleepy face', 'tired'],
    ['😴', 'sleeping face', 'sleep zzz'],
    ['😷', 'face with medical mask', 'sick mask'],
    ['🤒', 'face with thermometer', 'sick ill'],
    ['🤢', 'nauseated face', 'sick gross'],
    ['🤧', 'sneezing face', 'sick cold'],
    ['🥵', 'hot face', 'heat sweat'],
    ['🥶', 'cold face', 'freezing'],
    ['🥴', 'woozy face', 'dizzy'],
    ['😵', 'face with crossed-out eyes', 'dizzy dead'],
    ['🤯', 'exploding head', 'mind blown shocked'],
    ['🥳', 'partying face', 'party celebrate birthday'],
    ['😎', 'smiling face with sunglasses', 'cool'],
    ['🤓', 'nerd face', 'geek'],
    ['🧐', 'face with monocle', 'inspect'],
    ['😕', 'confused face', 'confused'],
    ['😟', 'worried face', 'worry'],
    ['🙁', 'slightly frowning face', 'sad'],
    ['😮', 'face with open mouth', 'wow surprise'],
    ['😲', 'astonished face', 'shocked'],
    ['😳', 'flushed face', 'embarrassed'],
    ['🥺', 'pleading face', 'please puppy'],
    ['😦', 'frowning face with open mouth', 'shock'],
    ['😨', 'fearful face', 'scared'],
    ['😰', 'anxious face with sweat', 'nervous'],
    ['😢', 'crying face', 'sad tear'],
    ['😭', 'loudly crying face', 'sob sad'],
    ['😱', 'face screaming in fear', 'scream shock'],
    ['😩', 'weary face', 'tired'],
    ['😫', 'tired face', 'exhausted'],
    ['🥱', 'yawning face', 'bored tired'],
    ['😤', 'face with steam from nose', 'frustrated'],
    ['😡', 'pouting face', 'angry mad'],
    ['😠', 'angry face', 'mad'],
    ['🤬', 'face with symbols on mouth', 'swear angry'],
    ['😈', 'smiling face with horns', 'devil'],
    ['💀', 'skull', 'dead'],
    ['💩', 'pile of poo', 'poop'],
    ['🤡', 'clown face', 'clown'],
    ['👻', 'ghost', 'boo halloween'],
    ['🤖', 'robot', 'bot'],
    ['😺', 'grinning cat', 'cat smile'],
    ['🙈', 'see-no-evil monkey', 'monkey oops'],
    ['🙉', 'hear-no-evil monkey', 'monkey'],
    ['🙊', 'speak-no-evil monkey', 'monkey secret'],
    ['👀', 'eyes', 'look see watching'],
    ['🧠', 'brain', 'smart think'],
    ['👶', 'baby', 'child'],
    ['🧑‍💻', 'technologist', 'developer laptop it'],
    ['🧑‍💼', 'office worker', 'business manager'],
    ['👨‍👩‍👧', 'family', 'parents'],
  ],
  gestures: [
    ['👍', 'thumbs up', 'like yes ok approve'],
    ['👎', 'thumbs down', 'dislike no'],
    ['👌', 'ok hand', 'okay perfect'],
    ['🤌', 'pinched fingers', 'italian'],
    ['✌️', 'victory hand', 'peace'],
    ['🤞', 'crossed fingers', 'luck hope'],
    ['🤟', 'love-you gesture', 'love'],
    ['🤘', 'sign of the horns', 'rock'],
    ['🤙', 'call me hand', 'call shaka'],
    ['👈', 'backhand index pointing left', 'left point'],
    ['👉', 'backhand index pointing right', 'right point'],
    ['👆', 'backhand index pointing up', 'up point'],
    ['👇', 'backhand index pointing down', 'down point'],
    ['☝️', 'index pointing up', 'one point'],
    ['✋', 'raised hand', 'stop high five'],
    ['🖐️', 'hand with fingers splayed', 'five'],
    ['👋', 'waving hand', 'wave hello bye hi'],
    ['🤚', 'raised back of hand', 'hand'],
    ['👏', 'clapping hands', 'clap applause bravo'],
    ['🙌', 'raising hands', 'celebrate hooray'],
    ['👐', 'open hands', 'hands'],
    ['🤲', 'palms up together', 'dua pray'],
    ['🤝', 'handshake', 'deal agreement'],
    ['🙏', 'folded hands', 'please thanks pray'],
    ['✍️', 'writing hand', 'write sign'],
    ['💪', 'flexed biceps', 'strong muscle'],
    ['🫶', 'heart hands', 'love'],
    ['🫡', 'saluting face', 'salute respect yes sir'],
    ['🤷', 'person shrugging', 'shrug dunno'],
    ['🤦', 'person facepalming', 'facepalm'],
    ['🙋', 'person raising hand', 'question me'],
    ['🙅', 'person gesturing no', 'no stop'],
    ['🙆', 'person gesturing ok', 'ok yes'],
    ['💁', 'person tipping hand', 'info sassy'],
    ['🙇', 'person bowing', 'sorry respect'],
    ['🏃', 'person running', 'run hurry'],
    ['🚶', 'person walking', 'walk'],
    ['💃', 'woman dancing', 'dance party'],
    ['🕺', 'man dancing', 'dance party'],
    ['👊', 'oncoming fist', 'punch fist bump'],
    ['✊', 'raised fist', 'fist power'],
  ],
  hearts: [
    ['❤️', 'red heart', 'love like'],
    ['🧡', 'orange heart', 'love'],
    ['💛', 'yellow heart', 'love'],
    ['💚', 'green heart', 'love'],
    ['💙', 'blue heart', 'love'],
    ['💜', 'purple heart', 'love'],
    ['🖤', 'black heart', 'love'],
    ['🤍', 'white heart', 'love'],
    ['🤎', 'brown heart', 'love'],
    ['💔', 'broken heart', 'sad heartbreak'],
    ['❣️', 'heart exclamation', 'love'],
    ['💕', 'two hearts', 'love'],
    ['💖', 'sparkling heart', 'love'],
    ['💯', 'hundred points', '100 perfect score'],
    ['💢', 'anger symbol', 'angry'],
    ['💥', 'collision', 'boom'],
    ['💫', 'dizzy', 'star'],
    ['💬', 'speech balloon', 'comment chat message'],
    ['💭', 'thought balloon', 'think'],
    ['💤', 'zzz', 'sleep'],
    ['✅', 'check mark button', 'done yes ok complete tick'],
    ['☑️', 'check box with check', 'done tick'],
    ['✔️', 'check mark', 'done yes tick'],
    ['❌', 'cross mark', 'no wrong cancel'],
    ['❎', 'cross mark button', 'no'],
    ['➕', 'plus', 'add'],
    ['➖', 'minus', 'subtract'],
    ['❓', 'red question mark', 'question'],
    ['❔', 'white question mark', 'question'],
    ['❗', 'red exclamation mark', 'important alert'],
    ['‼️', 'double exclamation mark', 'important'],
    ['⚠️', 'warning', 'caution alert'],
    ['🚫', 'prohibited', 'no forbidden'],
    ['⛔', 'no entry', 'stop'],
    ['🔴', 'red circle', 'red dot'],
    ['🟠', 'orange circle', 'orange dot'],
    ['🟡', 'yellow circle', 'yellow dot'],
    ['🟢', 'green circle', 'green dot online'],
    ['🔵', 'blue circle', 'blue dot'],
    ['🟣', 'purple circle', 'purple dot'],
    ['⚫', 'black circle', 'black dot'],
    ['⚪', 'white circle', 'white dot'],
    ['⭐', 'star', 'favourite'],
    ['🌟', 'glowing star', 'star shine'],
    ['✨', 'sparkles', 'shine new magic'],
    ['🔥', 'fire', 'hot lit'],
    ['🆕', 'new button', 'new'],
    ['🆗', 'ok button', 'ok'],
    ['🔝', 'top arrow', 'top'],
    ['🔁', 'repeat button', 'repeat loop'],
    ['🔄', 'counterclockwise arrows', 'refresh sync'],
    ['⬆️', 'up arrow', 'up'],
    ['⬇️', 'down arrow', 'down'],
    ['➡️', 'right arrow', 'right next'],
    ['⬅️', 'left arrow', 'left back'],
    ['🔔', 'bell', 'notification'],
    ['🔕', 'bell with slash', 'mute'],
    ['💲', 'heavy dollar sign', 'money price'],
    ['♻️', 'recycling symbol', 'recycle'],
    ['🕌', 'mosque', 'islam prayer'],
    ['☪️', 'star and crescent', 'islam'],
    ['🔟', 'keycap 10', 'ten'],
  ],
  objects: [
    ['📞', 'telephone receiver', 'phone call'],
    ['📱', 'mobile phone', 'phone cell'],
    ['💻', 'laptop', 'computer'],
    ['🖥️', 'desktop computer', 'computer'],
    ['⌨️', 'keyboard', 'type'],
    ['🖨️', 'printer', 'print'],
    ['📧', 'e-mail', 'email mail'],
    ['📩', 'envelope with arrow', 'email inbox'],
    ['📨', 'incoming envelope', 'email'],
    ['📎', 'paperclip', 'attachment'],
    ['📌', 'pushpin', 'pin'],
    ['📍', 'round pushpin', 'location pin'],
    ['✂️', 'scissors', 'cut'],
    ['🖊️', 'pen', 'write'],
    ['✏️', 'pencil', 'edit write'],
    ['📝', 'memo', 'note write'],
    ['📁', 'file folder', 'folder'],
    ['📂', 'open file folder', 'folder'],
    ['📄', 'page facing up', 'document file'],
    ['📃', 'page with curl', 'document'],
    ['📑', 'bookmark tabs', 'documents'],
    ['📊', 'bar chart', 'chart stats report'],
    ['📈', 'chart increasing', 'growth up trend'],
    ['📉', 'chart decreasing', 'down trend loss'],
    ['📋', 'clipboard', 'list'],
    ['📅', 'calendar', 'date schedule'],
    ['🗓️', 'spiral calendar', 'schedule'],
    ['📆', 'tear-off calendar', 'date'],
    ['🗂️', 'card index dividers', 'organize'],
    ['🗃️', 'card file box', 'archive'],
    ['🗑️', 'wastebasket', 'trash delete bin'],
    ['🔒', 'locked', 'lock secure private'],
    ['🔓', 'unlocked', 'open'],
    ['🔑', 'key', 'password'],
    ['🔍', 'magnifying glass', 'search find'],
    ['💡', 'light bulb', 'idea'],
    ['🔧', 'wrench', 'fix tool'],
    ['🔨', 'hammer', 'tool build'],
    ['⚙️', 'gear', 'settings'],
    ['🧰', 'toolbox', 'tools'],
    ['🔗', 'link', 'url chain'],
    ['💼', 'briefcase', 'work business'],
    ['💰', 'money bag', 'money cash'],
    ['💵', 'dollar banknote', 'money cash'],
    ['💳', 'credit card', 'card payment bank'],
    ['🏦', 'bank', 'finance'],
    ['🧾', 'receipt', 'invoice bill'],
    ['💎', 'gem stone', 'diamond'],
    ['⏰', 'alarm clock', 'time alarm'],
    ['⏳', 'hourglass not done', 'wait time'],
    ['⌛', 'hourglass done', 'time'],
    ['🕒', 'three o’clock', 'time clock'],
    ['📣', 'megaphone', 'announcement'],
    ['📢', 'loudspeaker', 'announcement'],
    ['🎉', 'party popper', 'celebrate congrats tada'],
    ['🎊', 'confetti ball', 'celebrate'],
    ['🎁', 'wrapped gift', 'present gift'],
    ['🎂', 'birthday cake', 'birthday'],
    ['🏆', 'trophy', 'win award'],
    ['🥇', 'first place medal', 'gold winner'],
    ['🎯', 'bullseye', 'target goal'],
    ['🚀', 'rocket', 'launch ship fast'],
    ['📦', 'package', 'box delivery'],
    ['🛒', 'shopping cart', 'cart buy'],
    ['📷', 'camera', 'photo'],
    ['🎥', 'movie camera', 'video'],
    ['🎤', 'microphone', 'voice'],
    ['🎧', 'headphone', 'music'],
    ['📚', 'books', 'read study'],
    ['🧮', 'abacus', 'calculate'],
    ['☕', 'hot beverage', 'coffee tea'],
    ['🔋', 'battery', 'power'],
    ['🔌', 'electric plug', 'power'],
  ],
  nature: [
    ['☀️', 'sun', 'sunny weather'],
    ['🌤️', 'sun behind small cloud', 'weather'],
    ['☁️', 'cloud', 'weather'],
    ['🌧️', 'cloud with rain', 'rain weather'],
    ['⛈️', 'cloud with lightning and rain', 'storm'],
    ['❄️', 'snowflake', 'cold snow'],
    ['🌈', 'rainbow', 'weather'],
    ['🌙', 'crescent moon', 'night ramadan'],
    ['⚡', 'high voltage', 'lightning fast'],
    ['💧', 'droplet', 'water'],
    ['🌊', 'water wave', 'sea ocean'],
    ['🌍', 'globe showing europe-africa', 'world earth'],
    ['🌴', 'palm tree', 'beach'],
    ['🌵', 'cactus', 'desert'],
    ['🌳', 'deciduous tree', 'tree'],
    ['🌱', 'seedling', 'plant grow'],
    ['🍀', 'four leaf clover', 'luck'],
    ['🌸', 'cherry blossom', 'flower'],
    ['🌹', 'rose', 'flower'],
    ['🌻', 'sunflower', 'flower'],
    ['💐', 'bouquet', 'flowers'],
    ['🐶', 'dog face', 'dog pet'],
    ['🐱', 'cat face', 'cat pet'],
    ['🐪', 'camel', 'desert'],
    ['🐎', 'horse', 'horse'],
    ['🦅', 'eagle', 'bird falcon'],
    ['🐦', 'bird', 'bird'],
    ['🐟', 'fish', 'fish'],
    ['🦁', 'lion', 'lion'],
    ['🐝', 'honeybee', 'bee busy'],
    ['🦋', 'butterfly', 'butterfly'],
    ['🐢', 'turtle', 'slow'],
    ['🍎', 'red apple', 'fruit'],
    ['🍊', 'tangerine', 'orange fruit'],
    ['🍌', 'banana', 'fruit'],
    ['🍉', 'watermelon', 'fruit'],
    ['🍇', 'grapes', 'fruit'],
    ['🍓', 'strawberry', 'fruit'],
    ['🥭', 'mango', 'fruit'],
    ['🥑', 'avocado', 'fruit'],
    ['🌶️', 'hot pepper', 'spicy'],
    ['🍞', 'bread', 'food'],
    ['🧀', 'cheese wedge', 'food'],
    ['🍗', 'poultry leg', 'chicken food'],
    ['🍔', 'hamburger', 'burger food'],
    ['🍟', 'french fries', 'fries food'],
    ['🍕', 'pizza', 'food'],
    ['🌯', 'burrito', 'shawarma wrap food'],
    ['🥙', 'stuffed flatbread', 'falafel shawarma food'],
    ['🍛', 'curry rice', 'biryani food'],
    ['🍚', 'cooked rice', 'rice food'],
    ['🍜', 'steaming bowl', 'noodles food'],
    ['🍣', 'sushi', 'food'],
    ['🍰', 'shortcake', 'cake dessert'],
    ['🍩', 'doughnut', 'donut dessert'],
    ['🍪', 'cookie', 'dessert'],
    ['🍫', 'chocolate bar', 'sweet'],
    ['🍿', 'popcorn', 'snack'],
    ['🫖', 'teapot', 'tea karak'],
    ['🍵', 'teacup without handle', 'tea'],
    ['🥤', 'cup with straw', 'drink juice'],
    ['🧃', 'beverage box', 'juice'],
    ['🍽️', 'fork and knife with plate', 'dinner lunch'],
  ],
  travel: [
    ['🚗', 'automobile', 'car drive'],
    ['🚕', 'taxi', 'cab'],
    ['🚌', 'bus', 'transport'],
    ['🚇', 'metro', 'subway train'],
    ['🚆', 'train', 'rail'],
    ['🚚', 'delivery truck', 'truck shipping'],
    ['🏍️', 'motorcycle', 'bike'],
    ['🚲', 'bicycle', 'bike'],
    ['✈️', 'airplane', 'flight travel plane'],
    ['🛫', 'airplane departure', 'flight'],
    ['🛬', 'airplane arrival', 'flight landing'],
    ['🚢', 'ship', 'boat cruise'],
    ['⛵', 'sailboat', 'boat'],
    ['🚦', 'traffic light', 'signal'],
    ['⛽', 'fuel pump', 'petrol gas'],
    ['🅿️', 'p button', 'parking'],
    ['🗺️', 'world map', 'map'],
    ['🧭', 'compass', 'direction'],
    ['🏠', 'house', 'home'],
    ['🏢', 'office building', 'office work'],
    ['🏬', 'department store', 'mall shop'],
    ['🏨', 'hotel', 'stay'],
    ['🏥', 'hospital', 'doctor'],
    ['🏫', 'school', 'education'],
    ['🏗️', 'building construction', 'construction'],
    ['🏙️', 'cityscape', 'city dubai'],
    ['🌆', 'cityscape at dusk', 'city evening'],
    ['🏖️', 'beach with umbrella', 'beach holiday'],
    ['🏜️', 'desert', 'sand'],
    ['🏝️', 'desert island', 'holiday'],
    ['⛰️', 'mountain', 'mountain'],
    ['🕋', 'kaaba', 'mecca hajj umrah'],
    ['🗼', 'tokyo tower', 'tower'],
    ['🗽', 'statue of liberty', 'new york'],
    ['🎡', 'ferris wheel', 'fun'],
    ['⛺', 'tent', 'camping'],
    ['🌅', 'sunrise', 'morning'],
    ['🌃', 'night with stars', 'night'],
    ['🧳', 'luggage', 'travel suitcase'],
    ['🛂', 'passport control', 'passport visa'],
    ['🎫', 'ticket', 'ticket'],
    ['⚽', 'soccer ball', 'football sport'],
    ['🏏', 'cricket game', 'cricket sport'],
    ['🏀', 'basketball', 'sport'],
    ['🎾', 'tennis', 'sport'],
    ['🏋️', 'person lifting weights', 'gym'],
  ],
  flags: [
    ['🇦🇪', 'united arab emirates', 'uae emirates dubai abu dhabi'],
    ['🇸🇦', 'saudi arabia', 'ksa saudi riyadh'],
    ['🇰🇼', 'kuwait', 'gcc'],
    ['🇶🇦', 'qatar', 'gcc doha'],
    ['🇧🇭', 'bahrain', 'gcc'],
    ['🇴🇲', 'oman', 'gcc muscat'],
    ['🇮🇳', 'india', 'in indian'],
    ['🇵🇰', 'pakistan', 'pk'],
    ['🇵🇭', 'philippines', 'ph filipino'],
    ['🇧🇩', 'bangladesh', 'bd'],
    ['🇱🇰', 'sri lanka', 'lk'],
    ['🇳🇵', 'nepal', 'np'],
    ['🇪🇬', 'egypt', 'eg'],
    ['🇯🇴', 'jordan', 'jo'],
    ['🇱🇧', 'lebanon', 'lb'],
    ['🇸🇾', 'syria', 'sy'],
    ['🇮🇶', 'iraq', 'iq'],
    ['🇹🇷', 'turkey', 'tr turkiye'],
    ['🇬🇧', 'united kingdom', 'uk gb britain england'],
    ['🇺🇸', 'united states', 'us usa america'],
    ['🇨🇦', 'canada', 'ca'],
    ['🇦🇺', 'australia', 'au'],
    ['🇫🇷', 'france', 'fr'],
    ['🇩🇪', 'germany', 'de'],
    ['🇨🇳', 'china', 'cn'],
    ['🇯🇵', 'japan', 'jp'],
    ['🇰🇷', 'south korea', 'kr korea'],
    ['🏁', 'chequered flag', 'finish race'],
    ['🚩', 'triangular flag', 'red flag'],
    ['🏳️', 'white flag', 'surrender'],
  ],
};

export const EMOJI: readonly EmojiEntry[] = EMOJI_CATEGORIES.flatMap(
  (category) =>
    RAW[category].map(([emoji, name, kw]) => ({
      emoji,
      name,
      keywords: kw.split(' ').filter(Boolean),
      category,
    }))
);

/** The emoji of one category, in display order. */
export const emojiIn = (category: EmojiCategory): EmojiEntry[] =>
  EMOJI.filter((e) => e.category === category);

/** The emoji a category tab shows. */
export const categoryIcon = (category: EmojiCategory): string =>
  RAW[category][0][0];

const byEmoji = new Map(EMOJI.map((e) => [e.emoji, e]));
/** The entry of a known emoji (a recent one may predate the list). */
export const emojiEntry = (emoji: string): EmojiEntry | undefined =>
  byEmoji.get(emoji);

/**
 * Case-insensitive search over names and keywords. Best first: a name
 * that starts with the query, then any word of the name or a keyword
 * starting with it, then a substring anywhere; list order breaks ties.
 * A blank query matches nothing (the picker shows categories instead).
 */
export function searchEmoji(query: string): EmojiEntry[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q) return [];
  const scored: { e: EmojiEntry; score: number; i: number }[] = [];
  EMOJI.forEach((e, i) => {
    const words = [...e.name.split(' '), ...e.keywords];
    const score = e.name.startsWith(q)
      ? 0
      : words.some((w) => w.startsWith(q))
        ? 1
        : e.name.includes(q) || e.keywords.some((k) => k.includes(q))
          ? 2
          : -1;
    if (score >= 0) scored.push({ e, score, i });
  });
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).map((s) => s.e);
}

/** What chat_toggle_reaction accepts: 1–32 characters. */
const isReactionSized = (s: unknown): s is string =>
  typeof s === 'string' && s.length >= 1 && s.length <= 32;

/** `emoji` first, any earlier copy removed, at most `max` kept. */
export function pushRecent(
  list: readonly string[],
  emoji: string,
  max = 24
): string[] {
  return [emoji, ...list.filter((e) => e !== emoji)].slice(0, max);
}

/** The stored recents, defensively: anything unexpected is dropped. */
export function parseRecents(raw: string | null, max = 24): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return [...new Set(v.filter(isReactionSized))].slice(0, max);
  } catch {
    return [];
  }
}

export type GridKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

/**
 * The cell an arrow key moves to in a grid of `count` cells, `cols`
 * wide: left/right step and stop at the ends, up/down jump a row and
 * stay put when there is no row there (a short last row clamps to its
 * last cell).
 */
export function gridMove(
  index: number,
  key: GridKey,
  count: number,
  cols: number
): number {
  if (count <= 0) return -1;
  const i = Math.min(Math.max(index, 0), count - 1);
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, i - 1);
    case 'ArrowRight':
      return Math.min(count - 1, i + 1);
    case 'ArrowUp':
      return i - cols >= 0 ? i - cols : i;
    case 'ArrowDown':
      if (i + cols < count) return i + cols;
      return Math.floor(i / cols) < Math.floor((count - 1) / cols)
        ? count - 1
        : i;
  }
}
