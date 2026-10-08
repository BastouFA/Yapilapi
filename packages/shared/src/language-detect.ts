/**
 * A small, offline language detector for posts, comments, story text and chat
 * messages. It runs when text is written (the server stores the result) and
 * needs no model and no dependency:
 *
 * 1. Links, @names, #tags, email addresses, numbers and emoji are ignored.
 * 2. The writing system decides most languages outright (Arabic script, Cyrillic,
 *    Greek, Hebrew, Devanagari, Bengali, Thai, Ethiopic, Hangul, kana, Han), with
 *    letters only Persian or Urdu use telling those apart from Arabic.
 * 3. Latin-script text is scored on common short words in each language, plus
 *    letters that belong to one language (ẹ ṣ in Yorùbá, ɗ ƙ ɓ in Hausa, ị ụ in
 *    Igbo, ñ in Spanish, ã õ in Portuguese, ư ơ đ in Vietnamese...).
 *
 * When the text is too short, or two languages score the same, it says nothing
 * (null) rather than guess: no "See translation" is better than a wrong one.
 * Server-side only (it uses Unicode property escapes); apps get `lang` from the API.
 */

type Scores = Record<string, number>;

const LATIN_WORDS: Record<string, string> = {
  en: `the and is are was were be been to of in on for with that this it you your my me we our they their he she his her not but have has had will would can could what when
    where who why how just so all about from at do does did dont im its there here today good love thanks thank hello happy day time people new see if or an as by out up get
    like very more some been them than then because really know want need going got make one great nice morning night everyone always never still also
    abeg wetin dey una wahala sabi oya`,
  fr: `le la les un une des du de et est sont je tu il elle nous vous ils elles on ce cette ces que qui pas ne avec pour dans sur mais ou tres bien mon ma mes ton ta tes
    son sa ses notre votre leur au aux merci bonjour bonsoir salut oui non cest jai aujourdhui etre avoir fait tout tous plus aussi comme quand beaucoup ca ete suis
    sommes etes chez encore deja toujours rien demain soir ami amis famille vie belle beau joyeux bonne quoi pourquoi voila`,
  es: `el la los las un una unos unas y es son esta estan que de del en con por para pero muy mas yo tu ella nosotros ustedes mi mis tus su sus se lo le no si hola
    gracias buenos buenas dia dias hoy manana como cuando donde tambien todo todos hay este esto ese esa al amigo amigos ya bien fue ser estoy tengo tiene hacer
    porque pues feliz vamos gente nada siempre ahora aqui`,
  pt: `o os as um uma e e sao esta estao que de do da dos das em no na nos nas com por para mas muito mais eu voce voces ele ela nos meu minha seu sua nao sim ola oi
    obrigado obrigada bom boa dia hoje amanha como quando onde tambem tudo todos isso isto este esta ao aos amigo amigos ja bem foi ser estou tenho tem fazer
    porque entao feliz gente agora aqui sempre nada`,
  sw: `na ya wa za kwa ni la katika hii huu hiyo yangu yako yake wetu wako mimi wewe yeye sisi ninyi wao sana leo kesho jana habari asante karibu rafiki mambo poa
    nzuri safi pia lakini kama sasa hapa pale kila watu mtu siku vizuri ndiyo hapana nini gani wapi lini nina una ana tuna wana kuwa kwenye hakuna nyumbani jambo
    sawa mungu furaha upendo heri hongera shikamoo marahaba tafadhali`,
  yo: `ati ni ti ko mo won re mi wa yii naa fun si lati je se ojo eku kaaro ekaaro bawo daadaa olorun oluwa ife owo ile omo pelu sugbon gbogbo bi ki jowo ese oseun
    emi iwo awa awon odun ire alafia jare nkan ohun kini nibo nigba`,
  ha: `da na ba ne ce ta ya yi ka ki su mu ku shi ita wannan wancan kuma amma domin saboda don zuwa daga cikin akan game yau gobe jiya sannu barka lafiya nagode
    gode godiya allah yana tana suna muna kuna ina mun sun kun yaya wane wace mutane mutum gida abinci aiki rana dare sosai kawai nan can haka tare babu akwai
    dai kai mana masa mata yara yan sabon sabuwar ranar zamu zan zai zata bamu ban kowa wani wata`,
  ig: `na nke ya ha ndi ihe onye bu ka maka nime otu ma mana kedu daalu nnoo chukwu chineke obi uto ututu nne nna nwanne ndewo anyi unu gi ga eme mere di nwere
    enwere ebe oge taa echi unyahu biko nwoke nwanyi nwa umu ego ulo ahu mmadu ezigbo ihunanya`,
  zu: `ngiyabonga siyabonga sawubona sanibonani yebo cha kanjani unjani ngikhona sikhona kodwa futhi kakhulu manje namhlanje kusasa izolo umuntu abantu
    ukuthi ngoba lapho lokhu lokho mina wena thina nina bona yena uthando ngiyakuthanda ekuseni kahle hamba sala ubaba umama ikhaya ingane izingane
    nkosi unkulunkulu impela ngicela ngifuna angazi akukho kukhona njalo nje`,
  de: `der die das und ist nicht ich du er sie wir ihr es ein eine einen mit auf fur von zu im den dem des auch aber wie was wer wo heute morgen danke hallo guten
    tag sehr gut mein meine dein sein haben habe hat sind bin war noch schon nur oder wenn dass mehr kein keine jetzt hier alle liebe`,
  it: `il lo la gli le un una uno e sono che di del della dei delle in con per ma molto piu io tu lui lei noi voi loro mio mia tuo tua suo sua non si ciao grazie
    buongiorno oggi domani come quando dove anche tutto tutti questo questa quello al alla amico amici bene stato essere ho ha hanno fare perche allora felice
    sempre ancora`,
  nl: `de het een en is zijn niet ik je jij hij zij we wij jullie met op voor van in te dat dit die maar ook heel erg goed dag hallo dank bedankt vandaag morgen mijn
    jouw haar ons onze hebben heb heeft was nog al wel geen niets alles nu hier er wat wie waar hoe als omdat`,
  pl: `nie jest to sie ze do jak ale co tak od po za mnie ja ty on ona my wy oni moj twoj jestem sa byl bardzo dzien dobry dziekuje czesc dzisiaj jutro wszystko
    tylko juz moze`,
  tr: `ve bir bu su da de ile icin ama cok daha ben sen biz siz onlar benim senin var yok degil ne nasil neden nerede merhaba selam tesekkurler tesekkur sagol
    gunaydin bugun yarin guzel iyi her sey gibi kadar mi mu olarak oldu olan ki`,
  id: `yang dan di ke dari ini itu dengan untuk tidak ada saya aku kamu anda dia kami kita mereka akan sudah belum juga bisa sangat lagi hari terima kasih selamat
    pagi apa siapa bagaimana kenapa karena tapi atau jadi sama semua banyak baik bagus orang rumah sekarang besok kemarin`,
  vi: `va cua cac nhung mot khong toi ban anh chung nay duoc cho voi trong nguoi rat cam xin chao hom ngay gi sao nao cung dang`,
};

const WORDS: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const [lang, list] of Object.entries(LATIN_WORDS)) for (const w of new Set(list.split(/\s+/).filter(Boolean))) m.set(w, [...(m.get(w) ?? []), lang]);
  return m;
})();

/** Letters that belong to one language (or nearly), with how much each sighting counts, capped per language. */
const LETTERS: [RegExp, string, number][] = [
  [/[ẹṣ]/gu, 'yo', 3],
  [/[ịụṅ]/gu, 'ig', 3],
  [/[ɓɗƙƴ]/gu, 'ha', 3],
  [/[ăđơưảẻẽỉỏủỷỹấầẩẫậắằẳẵặếềểễệốồổỗộớờởỡợứừửữựạ]/gu, 'vi', 3],
  [/[ığş]/gu, 'tr', 3],
  [/[łąęśźżńć]/gu, 'pl', 3],
  [/[ßäö]/gu, 'de', 2],
  [/[ñ¿¡]/gu, 'es', 2],
  [/[ãõ]/gu, 'pt', 3],
  [/[èêëîïûùœ]/gu, 'fr', 1],
  [/[ìò]/gu, 'it', 1],
];

// Stripped before detection: links, emails, @names, #tags, digits.
const NOISE = /https?:\/\/\S+|www\.\S+|\S+@\S+\.\S+|[@#][\p{L}\p{M}\p{N}_.]+|\p{N}+/gu;

const SCRIPTS: [RegExp, string][] = [
  [/[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/gu, 'arab'],
  [/[֐-׿]/gu, 'he'],
  [/[Ѐ-ӿ]/gu, 'cyrl'],
  [/[Ͱ-Ͽἀ-῿]/gu, 'el'],
  [/[ऀ-ॿ]/gu, 'hi'],
  [/[ঀ-৿]/gu, 'bn'],
  [/[฀-๿]/gu, 'th'],
  [/[ሀ-᎟ⶀ-⷟]/gu, 'am'],
  [/[가-힯ᄀ-ᇿ㄰-㆏]/gu, 'ko'],
  [/[぀-ヿ]/gu, 'kana'],
  [/[一-鿿㐀-䶿]/gu, 'han'],
  [/\p{Script=Latin}/gu, 'latn'],
];

const count = (text: string, re: RegExp) => text.match(re)?.length ?? 0;

/** Letters with their accents taken off, for matching the word lists ("não" → "nao", "ẹ̀kú" → "eku"). */
function fold(word: string): string {
  return word
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ı/g, 'i')
    .replace(/ł/g, 'l')
    .replace(/[đɗ]/g, 'd')
    .replace(/ɓ/g, 'b')
    .replace(/ƙ/g, 'k')
    .replace(/ƴ/g, 'y')
    .replace(/ß/g, 'ss')
    .replace(/œ/g, 'oe')
    .replace(/['’]/g, '');
}

function latin(text: string): string | null {
  const scores: Scores = {};
  const add = (lang: string, n: number) => (scores[lang] = (scores[lang] ?? 0) + n);
  const words = text.toLowerCase().match(/[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu) ?? [];
  for (const raw of words) {
    // French elision: l'amour, j'ai, qu'il, c'est.
    if (/^(?:l|d|j|qu|n|s|c|m|t)['’]\p{L}/u.test(raw)) add('fr', 1);
    const w = fold(raw);
    if (w.length < 2) continue;
    for (const lang of WORDS.get(w) ?? []) add(lang, 1);
  }
  const lower = text.toLowerCase();
  for (const [re, lang, weight] of LETTERS) {
    const n = count(lower, re);
    if (n) add(lang, Math.min(n, 4) * weight);
  }
  // Yorùbá tone marks on dotted vowels (ọ́, ọ̀, ẹ́) come apart under NFD; a dot below with a tone is Yorùbá.
  if (/[aeiou]̣[̀́]/u.test(lower.normalize('NFD')) && !scores.vi) add('yo', 2);
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (!best || best[1] < 1) return null;
  if (second && second[1] === best[1]) return null;
  // A single weak hit in a longer text isn't enough to say.
  if (best[1] < 2 && words.length > 4) return null;
  return best[0];
}

/**
 * The language of a piece of text as an ISO 639-1 code, or null when it can't
 * tell (too short, only emoji or links, or evenly split).
 */
export function detectLanguage(input: string | null | undefined): string | null {
  if (!input) return null;
  const text = input.normalize('NFC').replace(NOISE, ' ');
  const scripts: Scores = {};
  let letters = 0;
  for (const [re, name] of SCRIPTS) {
    const n = count(text, re);
    if (n) {
      scripts[name] = n;
      letters += n;
    }
  }
  if (letters < 2) return null;
  // Kana anywhere with Han makes it Japanese.
  if (scripts.kana) {
    scripts.kana += scripts.han ?? 0;
    delete scripts.han;
  }
  const [top] = Object.entries(scripts).sort((a, b) => b[1] - a[1]);
  switch (top![0]) {
    case 'arab':
      if (/[ٹڈڑںےۓ]/u.test(text)) return 'ur';
      if (/[پچژگیک]/u.test(text)) return 'fa';
      return 'ar';
    case 'cyrl':
      return /[іїєґ]/iu.test(text) ? 'uk' : 'ru';
    case 'kana':
      return 'ja';
    case 'han':
      return 'zh';
    case 'latn':
      return latin(text);
    default:
      return top![0];
  }
}

// ── Keeping #tags, @names and links as they are ─────────────────────────────
// Before text goes to a model, every hashtag, mention, link and email address is
// swapped for a numbered marker, and swapped back afterwards. The model never sees
// them, so it can't translate, respell or drop them.

const PROTECTED = new RegExp(
  [
    'https?:\\/\\/[^\\s<>"]+', // links
    'www\\.[^\\s<>"]+',
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', // email addresses
    '(?<=^|[\\s(\\[{"\'“‘«])[@#][^\\s.,;:!?¡¿()\\[\\]{}"\'“”‘’«»]+', // @names and #tags
  ].join('|'),
  'gu',
);

const MARKER = /⟦(\d+)⟧/g;

/** The text with markers in place of tags, mentions and links, and what each marker stands for. */
export function protectForTranslation(text: string): { text: string; tokens: string[] } {
  const tokens: string[] = [];
  // Marker-like brackets in the original can't be confused with ours.
  const safe = text.replace(/[⟦⟧]/g, (c) => (c === '⟦' ? '[' : ']'));
  const out = safe.replace(PROTECTED, (m) => {
    // Sentence punctuation after a link stays outside it.
    const trail = /[.,;:!?)\]]+$/.exec(m)?.[0] ?? '';
    const core = trail ? m.slice(0, -trail.length) : m;
    if (!core) return m;
    tokens.push(core);
    return `⟦${tokens.length - 1}⟧${trail}`;
  });
  return { text: out, tokens };
}

/**
 * Put tags, mentions and links back. Any the model dropped are added at the end,
 * so a translation never loses one; markers it invented are removed.
 */
export function restoreTranslation(translated: string, tokens: readonly string[]): string {
  const used = new Set<number>();
  let out = translated.replace(MARKER, (_m, n: string) => {
    const i = Number(n);
    if (i >= tokens.length || used.has(i)) return '';
    used.add(i);
    return tokens[i]!;
  });
  const missing = tokens.filter((_t, i) => !used.has(i));
  if (missing.length) out = `${out.trimEnd()} ${missing.join(' ')}`;
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}
