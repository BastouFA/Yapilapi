import { formatMoney, type MessageKey, type PluralKey } from './i18n-core.ts';
import { formatList } from './feed-reasons.ts';
import type { GroupLineAction, Message, MessagePreview, StoryReply } from './types.ts';

/**
 * One line about a message, in the reader's language: a quoted reply, a pin, a chat's last
 * message in the inbox. Cards the server makes (a location, a game, an offer) and replies to a
 * story are said from what they are, not from their body, which older servers wrote in English;
 * a message kept from before still reads as it was stored. The phone imports this file directly,
 * so no zod.
 */

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

export interface PreviewTranslator {
  t: T;
  /** For amounts ("₦5,000.00"); English formatting without it. */
  locale?: string;
  /** Who is reading, so a reply to a story says whose story it was. */
  meId?: string;
}

/** A message as a quote: for the reply bar before sending, or a last message the server sent without its own preview. */
export function messagePreviewOf(m: Message): MessagePreview {
  return {
    id: m.id,
    available: true,
    sender: m.sender,
    body: m.body.slice(0, 200),
    attachmentKind: m.attachments[0]?.kind ?? m.viewOnce?.kind ?? null,
    createdAt: m.createdAt,
    ...(m.unsent ? { unsent: true } : {}),
    ...(m.storyReply ? { storyReply: m.storyReply } : {}),
    ...(m.viewOnce ? { viewOnce: true } : {}),
    ...(m.kind === 'yap' ? { yap: true } : {}),
    ...(m.poll
      ? { kind: 'poll' as const }
      : m.list
        ? { kind: 'list' as const }
        : m.game
          ? { kind: 'game' as const, gameKind: m.game.kind }
          : m.mix
            ? { kind: 'mix' as const }
            : m.location
              ? { kind: 'location' as const, live: m.location.mode === 'live' }
              : m.market
                ? { kind: 'listing' as const }
                : m.offer
                  ? {
                      kind: 'offer' as const,
                      offer: { amountCents: m.offer.amountCents, currency: m.offer.currency, counter: !!m.offer.counterOfId },
                    }
                  : {}),
  };
}

/**
 * The line above a reply to a story: "Replied to your story" for the person whose story it was,
 * "You replied to their story" for whoever sent it, or the story's words when it had some.
 */
export function storyReplyLabel(r: StoryReply, senderId: string | null | undefined, meId: string | undefined, t: T): string {
  if (r.quote) return t('chat.storyReply.quote', { quote: r.quote });
  return senderId && senderId === meId ? t('chat.storyReply.theirs') : t('chat.storyReply.yours');
}

/** The amount of an offer or a counter-offer ("Offer · ₦5,000.00"). */
function offerLine(o: { amountCents: number; currency: string; counter: boolean }, tr: PreviewTranslator): string {
  let amount: string;
  try {
    amount = formatMoney(o.amountCents, o.currency, tr.locale ?? 'en');
  } catch {
    amount = `${(o.amountCents / 100).toFixed(2)} ${o.currency}`;
  }
  return tr.t(o.counter ? 'market.preview.counterAmount' : 'market.preview.offerAmount', { amount });
}

/** One line describing a message. */
export function messagePreviewText(p: MessagePreview, tr: PreviewTranslator): string {
  const { t } = tr;
  if (!p.available) return t('m.chat.quoteUnavailable');
  if (p.unsent) return t('m.chat.unsent');
  if (p.kind === 'poll') return t('m.chat.poll.preview', { question: p.body });
  if (p.kind === 'list') return t('m.chat.list.preview', { title: p.body });
  if (p.kind === 'mix') return t('mixes.preview', { title: p.body });
  if (p.kind === 'location') return t(p.live ? 'location.live' : 'location.pin');
  // A Market listing (body is its title) or an offer on one (older servers wrote the amount in English in the body).
  if (p.kind === 'listing') return t('market.preview.listing', { title: p.body });
  if (p.kind === 'offer') return p.offer ? offerLine(p.offer, tr) : p.body || t('market.preview.offer');
  if (p.kind === 'game') return t('m.chat.game.preview', { game: p.gameKind ? t(`m.chat.game.kind.${p.gameKind}` as MessageKey) : p.body });
  if (p.storyReply) return t('chat.storyReply.preview', { label: storyReplyLabel(p.storyReply, p.sender?.id, tr.meId, t), text: p.body });
  // A view-once photo, video or voice note says so, never more; a yap is a yap.
  if (p.viewOnce)
    return t(p.attachmentKind === 'video' ? 'm.viewOnce.videoSent' : p.attachmentKind === 'audio' ? 'm.viewOnce.voiceSent' : 'm.viewOnce.photoSent');
  if (p.yap) return t('m.yap.label');
  if (p.body) return p.body;
  switch (p.attachmentKind) {
    case 'image':
      return t('m.post.photo');
    case 'video':
      return t('m.chat.video');
    case 'audio':
      return t('m.chat.voiceMessage');
    default:
      return p.attachmentKind ? t('m.chat.attachment') : t('chat.message');
  }
}

/**
 * A chat's last message in the inbox, in the reader's language: what it is, or a line about a call
 * or the group ("Missed video call", "Ada added Léa"). `tp` counts a call's minutes.
 */
export function lastMessageText(
  m: Message,
  tr: PreviewTranslator & { tp: (key: PluralKey, count: number, vars?: Record<string, string | number>) => string },
): string {
  const s = m.kind === 'system' ? m.system : undefined;
  if (s?.type === 'call') return callLineText(s, m.sender.id, tr);
  if (s?.type === 'group') return groupLineText(s, m.sender.id === tr.meId ? tr.t('m.chat.you') : m.sender.displayName, tr);
  return messagePreviewText(m.preview ?? messagePreviewOf(m), tr);
}

/**
 * A call's line in the chat ("Missed video call", "Audio call, 3 minutes"). The caller (`callerId`,
 * the line's sender) reads a missed call as "no answer". Needs `tp` for the minutes.
 */
export function callLineText(
  info: { kind: 'audio' | 'video'; outcome: 'missed' | 'declined' | 'ended'; seconds: number | null },
  callerId: string,
  tr: PreviewTranslator & { tp: (key: PluralKey, count: number, vars?: Record<string, string | number>) => string },
): string {
  const video = info.kind === 'video';
  if (info.outcome === 'ended') {
    const duration = tr.tp('chat.call.minutes', Math.max(1, Math.round((info.seconds ?? 0) / 60)));
    return tr.t(video ? 'chat.call.endedVideo' : 'chat.call.endedAudio', { duration });
  }
  if (info.outcome === 'declined') return tr.t(video ? 'chat.call.declinedVideo' : 'chat.call.declinedAudio');
  if (callerId === tr.meId) return tr.t(video ? 'chat.call.noAnswerVideo' : 'chat.call.noAnswerAudio');
  return tr.t(video ? 'chat.call.missedVideo' : 'chat.call.missedAudio');
}

const GROUP_LINE_KEYS = {
  renamed: 'chat.group.renamed',
  added: 'chat.group.added',
  removed: 'chat.group.removed',
  left: 'chat.group.left',
  admin: 'chat.group.admin',
  unadmin: 'chat.group.unadmin',
  promoted: 'chat.group.promoted',
} as const satisfies Record<GroupLineAction, MessageKey>;

/**
 * A group line ("Ada added Léa and Kofi", "You left the group") in the reader's language. `name` is
 * who did it as the reader says it (their own "You"); `people` are named as they were then, "You"
 * for the reader.
 */
export function groupLineText(
  info: { action: GroupLineAction; title?: string; people?: { id: string; displayName: string }[] },
  name: string,
  tr: PreviewTranslator,
): string {
  if (info.action === 'promoted' && info.people?.length === 1 && info.people[0]!.id === tr.meId) return tr.t('chat.group.promotedYou');
  const people = formatList(
    (info.people ?? []).map((p) => (p.id === tr.meId ? tr.t('chat.group.you') : p.displayName)),
    tr.locale,
    (k) => tr.t(k),
  );
  return tr.t(GROUP_LINE_KEYS[info.action], { name, people, title: info.title ?? '' });
}
