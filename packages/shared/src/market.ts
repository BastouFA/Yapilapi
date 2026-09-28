import type { PublicUser } from './types.ts';

/**
 * Market: people selling and buying used and local things near them, person to person. It is
 * separate from the creator shop (products, orders and payouts in commerce): nothing is paid in the
 * app. People meet and pay in person, so there are no fees, no checkout and no app store rules for
 * digital goods; the listing and the chat card carry plain safety tips instead.
 *
 * A listing has up to MARKET_MAX_PHOTOS photos (the seller's own uploads), a price in the currency
 * of the seller's country (or Free), a condition, a category, a pickup area written as text and,
 * when the seller gives it, a point snapped to a grid about a kilometre across (LOCATION_APPROXIMATE_METRES,
 * snapped on the device and again on the server). The point is never sent to anyone: people see the
 * area text and "about 3 km away", worked out by the server and rounded to whole kilometres.
 *
 * Listings run for MARKET_LISTING_DAYS, with a reminder MARKET_REMINDER_DAYS before they end, and can be
 * renewed. Only adults sell; everyone 13 and over can browse. Talking about a listing happens in a
 * one-to-one chat (the usual rules: blocks, who can message whom, and adults and under-18s only
 * as friends), which starts with a card for the listing; offers are cards in that chat.
 *
 * No zod here: the mobile app imports this file directly. The request schemas are in market-schemas.ts.
 */

export const MARKET_CATEGORIES = [
  'electronics',
  'phones',
  'computers',
  'home',
  'furniture',
  'appliances',
  'clothing',
  'shoes_bags',
  'beauty',
  'baby_kids',
  'toys_games',
  'sports',
  'books',
  'music',
  'vehicles',
  'bikes',
  'tools',
  'garden',
  'art_crafts',
  'other',
] as const;
export type MarketCategory = (typeof MARKET_CATEGORIES)[number];

export const MARKET_CONDITIONS = ['new', 'like_new', 'good', 'fair'] as const;
export type MarketCondition = (typeof MARKET_CONDITIONS)[number];

/** How the item can change hands: the buyer picks it up, the seller brings it, or it's posted. */
export const MARKET_DELIVERY = ['pickup', 'seller_delivers', 'shipping'] as const;
export type MarketDelivery = (typeof MARKET_DELIVERY)[number];

export const MARKET_STATUSES = ['available', 'reserved', 'sold'] as const;
export type MarketStatus = (typeof MARKET_STATUSES)[number];

/**
 * What can't be sold on Market. A listing whose words look like one of these is stopped before it's
 * published (the seller can say it isn't, and then it waits for a moderator before anyone sees it).
 */
export const MARKET_PROHIBITED = ['weapons', 'drugs', 'animals', 'alcohol', 'tobacco', 'adult', 'counterfeit', 'recalled', 'medicines'] as const;
export type MarketProhibited = (typeof MARKET_PROHIBITED)[number];

export const MARKET_MAX_PHOTOS = 10;
export const MARKET_TITLE_MAX = 80;
export const MARKET_DESCRIPTION_MAX = 2000;
export const MARKET_AREA_MAX = 80;
export const MARKET_PHOTO_ALT_MAX = 300;
/** Prices in hundredths of the currency, up to 10 billion in the currency itself. */
export const MARKET_PRICE_MAX_CENTS = 1_000_000_000_000;
/** A listing runs this long from when it's published or renewed. */
export const MARKET_LISTING_DAYS = 30;
/** The seller is reminded this long before it ends. */
export const MARKET_REMINDER_DAYS = 3;
/** A listing can be renewed once it has at most this many days left, or after it ended. */
export const MARKET_RENEW_WITHIN_DAYS = 7;
/** New listings per person in 24 hours. */
export const MARKET_LISTINGS_PER_DAY = 10;
/** How far to look, in kilometres. */
export const MARKET_RADII_KM = [2, 5, 10, 25, 50, 100] as const;
export type MarketRadius = (typeof MARKET_RADII_KM)[number];
export const MARKET_DEFAULT_RADIUS_KM: MarketRadius = 10;
export const MARKET_RATING_TEXT_MAX = 300;
/** Scam signals: a listing priced under this share of the category's median (same currency) waits for review... */
export const MARKET_LOW_PRICE_RATIO = 0.2;
/** ...once the category has at least this many priced listings in the last 90 days. */
export const MARKET_MEDIAN_MIN_LISTINGS = 5;
/** The same words on this many listings in 7 days (by one person, or by anyone) wait for review. */
export const MARKET_DUPLICATE_LISTINGS = 3;
/** A seller's response rate shows once this many people have written to them about listings. */
export const MARKET_RESPONSE_RATE_MIN_CHATS = 3;

/** One photo on a listing. */
export interface MarketPhoto {
  mediaId: string;
  url: string;
  /** A smaller size for grids, when there is one. */
  thumbUrl: string;
  width: number | null;
  height: number | null;
  altText: string | null;
}

/** Where a listing is, as others see it: the area text and, when both sides gave a place, how far. */
export interface MarketWhere {
  area: string;
  /** Rounded to whole kilometres, at least 1. Null when the listing or you have no place. */
  distanceKm: number | null;
}

/** Why you can't write to a seller about a listing, when you can't. */
export type MarketContactBlock = 'self' | 'minor_protection' | 'blocked' | 'unavailable';

export interface MarketListing {
  id: string;
  seller: PublicUser;
  title: string;
  description: string;
  category: MarketCategory;
  condition: MarketCondition;
  /** Hundredths of `currency`; null when it's free. */
  priceCents: number | null;
  currency: string;
  photos: MarketPhoto[];
  where: MarketWhere;
  /** The seller gave an approximate place (it's never sent; only distances are). */
  hasPlace: boolean;
  delivery: MarketDelivery[];
  status: MarketStatus;
  /** It stops showing to others at this time unless it's renewed. */
  expiresAt: string;
  /** Past expiresAt and not sold. */
  expired: boolean;
  /** The seller may renew it now. Only on your own. */
  canRenew?: boolean;
  createdAt: string;
  updatedAt: string;
  /** Yours. */
  mine: boolean;
  saved: boolean;
  /** Your own listing while a moderator checks it ('review'), or after it was limited ('restricted'). */
  moderation?: 'review' | 'restricted';
  /** Why a moderator check was asked for, on your own listing waiting for review. */
  reviewReason?: 'prohibited' | 'duplicate' | 'low_price' | 'photos' | 'text';
  /** Whether you can write to the seller or make an offer; `contactBlock` says why not. */
  canContact: boolean;
  contactBlock?: MarketContactBlock;
  /** Reserved or sold to you. */
  forYou?: boolean;
}

/** A listing in a chat, as a card: enough to recognise it, and whether it's still there for you. */
export interface MarketListingCard {
  id: string;
  /** False when it was deleted, taken down, or you can't see it any more: show "No longer available". */
  available: boolean;
  title: string;
  priceCents: number | null;
  currency: string;
  photoUrl: string | null;
  status: MarketStatus;
  expired: boolean;
  sellerId: string;
}

/** The seller card on a listing. */
export interface MarketSellerCard {
  user: PublicUser;
  /** When they joined YAPILAPI. */
  memberSince: string;
  /** From people who bought from them. Null average when there are none yet. */
  rating: { average: number | null; count: number };
  /** Share (0 to 100) of people who wrote about a listing and got an answer; null with fewer than MARKET_RESPONSE_RATE_MIN_CHATS. */
  responseRate: number | null;
  sold: number;
}

/** A listing with its seller card, for the listing page. */
export interface MarketListingDetail extends MarketListing {
  sellerCard: MarketSellerCard;
  /** Your one-to-one chat about it, when there is one. */
  conversationId: string | null;
  /** Only on your own: people who wrote to you about it, to mark it reserved or sold to one of them. */
  buyers?: PublicUser[];
  /** When it's sold to you (or you sold it): whether you rated the other person yet. */
  rating?: { canRate: boolean; rated: boolean; otherUser: PublicUser | null };
}

export const MARKET_OFFER_STATUSES = ['pending', 'accepted', 'declined', 'countered', 'withdrawn'] as const;
export type MarketOfferStatus = (typeof MARKET_OFFER_STATUSES)[number];

/** An offer (or a counter-offer from the seller) as a card in the chat about a listing. */
export interface MarketOffer {
  id: string;
  listingId: string;
  conversationId: string;
  messageId: string;
  buyer: PublicUser;
  seller: PublicUser;
  /** Who made this amount. */
  madeBy: 'buyer' | 'seller';
  amountCents: number;
  currency: string;
  status: MarketOfferStatus;
  /** The offer this one answers, for counter-offers. */
  counterOfId: string | null;
  createdAt: string;
  respondedAt: string | null;
  /** You can accept, decline or counter it (you're the other person and it's pending). */
  canRespond: boolean;
  /** You made it and it's still pending. */
  canWithdraw: boolean;
  listing: MarketListingCard;
}

/** The card at the top of a chat about a listing. */
export interface MarketChatCard {
  listing: MarketListingCard;
  buyer: PublicUser;
  seller: PublicUser;
  /** Who you are in this chat. */
  you: 'buyer' | 'seller';
  /** The seller can mark it reserved for, or sold to, this buyer. */
  canMarkSold: boolean;
  canMarkReserved: boolean;
  /** Reserved for or sold to the buyer in this chat. */
  reservedForBuyer: boolean;
  soldToBuyer: boolean;
  /** After the sale: you may leave a rating for the other person, or already did. */
  canRate: boolean;
  rated: boolean;
}

export interface MarketRating {
  id: string;
  listingId: string;
  listingTitle: string;
  rater: PublicUser;
  /** The rater's side of the sale. */
  raterRole: 'buyer' | 'seller';
  stars: number;
  body: string;
  createdAt: string;
}

/** Someone's Market tab: their listings for sale and what people said about buying and selling with them. */
export interface MarketProfile {
  seller: MarketSellerCard;
  listings: MarketListing[];
  ratings: MarketRating[];
  /** As a buyer: ratings from sellers. */
  asBuyer: { average: number | null; count: number };
}

/** What you can do on Market, and in which currency your prices are. */
export interface MarketMe {
  currency: string;
  canSell: boolean;
  /** Why you can't sell: under 18, or no date of birth on the account. */
  sellBlock: 'adults_only' | 'birth_date_required' | null;
  /** New listings you can still publish in the next 24 hours. */
  listingsLeftToday: number;
}

/** Public preview of a listing for shared links (no account needed). */
export interface PublicListingPreview {
  id: string;
  title: string;
  excerpt: string;
  priceCents: number | null;
  currency: string;
  condition: MarketCondition;
  category: MarketCategory;
  area: string;
  imageUrl: string | null;
  status: MarketStatus;
  /** The seller's name, only for public accounts. */
  seller: { username: string; displayName: string } | null;
}

// ── Checks before publishing ────────────────────────────────────────────

/** Lower case, accents off, and anything that isn't a letter or digit as one space, with a space at each end. */
function normalise(text: string): string {
  const plain = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return ` ${plain.replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/** Everyday things whose names contain a listed word ("glue gun", "wine glass"): taken out before looking. */
const HARMLESS = [
  'glue gun',
  'nail gun',
  'massage gun',
  'heat gun',
  'spray gun',
  'paint gun',
  'water gun',
  'nerf gun',
  'toy gun',
  'staple gun',
  'wine glass',
  'wine glasses',
  'wine rack',
  'wine cooler',
  'wine fridge',
  'wine opener',
  'beer mug',
  'beer glass',
  'beer glasses',
  'champagne glass',
  'champagne glasses',
  'puppy pad',
  'puppy pads',
  'fake plant',
  'fake plants',
  'fake flower',
  'fake flowers',
  'fake fur',
  'fake lashes',
  'fake eyelashes',
  'pill organiser',
  'pill organizer',
  'pill box',
  'first aid kit',
  'dog bed',
  'cat tree',
];

/** Words and phrases for each prohibited kind (normalised: lower case, no accents), in the app's languages where they differ. */
const PROHIBITED_WORDS: Record<MarketProhibited, string[]> = {
  weapons: [
    'gun',
    'guns',
    'handgun',
    'pistol',
    'pistols',
    'revolver',
    'rifle',
    'rifles',
    'shotgun',
    'firearm',
    'firearms',
    'ammo',
    'ammunition',
    'bullets',
    'grenade',
    'explosives',
    'silencer',
    'crossbow',
    'brass knuckles',
    'taser',
    'stun gun',
    'fusil',
    'pistolet',
    'arme a feu',
    'munitions',
    'pistola',
    'escopeta',
    'arma de fogo',
    'arma de fuego',
    'bunduki',
    'risasi',
  ],
  drugs: [
    'cocaine',
    'heroin',
    'meth',
    'methamphetamine',
    'mdma',
    'ecstasy',
    'lsd',
    'weed',
    'marijuana',
    'cannabis',
    'ganja',
    'kush',
    'thc',
    'cbd',
    'hashish',
    'psilocybin',
    'magic mushrooms',
    'shrooms',
    'indian hemp',
    'cocaina',
    'maconha',
    'bangi',
    'bhang',
  ],
  animals: [
    'puppy',
    'puppies',
    'kitten',
    'kittens',
    'parrot',
    'parrots',
    'live animal',
    'live animals',
    'livestock',
    'goat',
    'goats',
    'dog for sale',
    'cat for sale',
    'pet for sale',
    'chiot',
    'chiots',
    'chaton',
    'chatons',
    'cachorro',
    'cachorros',
    'perrito',
    'perritos',
    'gatito',
    'gatitos',
    'mbuzi',
  ],
  alcohol: [
    'beer',
    'beers',
    'wine',
    'wines',
    'whisky',
    'whiskey',
    'vodka',
    'rum',
    'tequila',
    'champagne',
    'liquor',
    'alcohol',
    'biere',
    'vinho',
    'cerveza',
    'cerveja',
    'pombe',
    'palm wine',
    'ogogoro',
  ],
  tobacco: [
    'cigarette',
    'cigarettes',
    'cigar',
    'cigars',
    'tobacco',
    'vape',
    'vapes',
    'vaping',
    'e cigarette',
    'shisha',
    'hookah',
    'snuff',
    'juul',
    'nicotine',
    'cigarro',
    'cigarros',
    'tabac',
    'tabaco',
    'sigara',
  ],
  adult: ['sex toy', 'sex toys', 'sextoy', 'dildo', 'vibrator', 'adult toy', 'adult toys', 'porn', 'xxx', 'fleshlight'],
  counterfeit: [
    'replica',
    'replicas',
    'counterfeit',
    'fake',
    'knockoff',
    'knock off',
    'first copy',
    '1st copy',
    'aaa quality',
    'mirror quality',
    'contrefacon',
    'falsificado',
    'falsificada',
  ],
  recalled: ['recalled', 'product recall', 'under recall'],
  medicines: [
    'prescription',
    'antibiotic',
    'antibiotics',
    'tramadol',
    'codeine',
    'viagra',
    'cialis',
    'xanax',
    'valium',
    'diazepam',
    'oxycodone',
    'insulin',
    'medicine',
    'medicines',
    'medication',
    'medications',
    'medicament',
    'medicaments',
    'medicamento',
    'medicamentos',
    'dawa',
    'pills',
  ],
};

/**
 * Whether a listing's words look like something that can't be sold on Market, and which kind. It
 * looks for whole words only (so "rum" doesn't match "drum") after taking out everyday phrases such
 * as "glue gun". It's a first check, not a verdict: the seller can say it isn't, and the listing
 * then waits for a moderator. The API runs the same check whatever the app did.
 */
export function prohibitedMatch(...texts: (string | null | undefined)[]): MarketProhibited | null {
  let text = normalise(texts.filter(Boolean).join(' \n '));
  for (const phrase of HARMLESS) text = text.replaceAll(` ${phrase} `, ' ');
  for (const kind of MARKET_PROHIBITED) for (const word of PROHIBITED_WORDS[kind]) if (text.includes(` ${word} `)) return kind;
  return null;
}

/** Words that stand for the same listing text however it's spaced or capitalised (for spotting copies). */
export function listingFingerprintText(title: string, description: string): string {
  return normalise(`${title} ${description}`).trim();
}

/** Distance as shown: whole kilometres, at least 1 (a place is only known to about a kilometre). */
export function marketDistanceKm(metres: number): number {
  return Math.max(1, Math.round(metres / 1000));
}

/** Days left before a listing ends (0 when it has ended). */
export function marketDaysLeft(expiresAt: string, now = new Date()): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / 86_400_000));
}
