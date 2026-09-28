import { describe, expect, it } from 'vitest';
import { CATALOGS, SUPPORTED_LOCALES, t, tp, type MessageKey } from './i18n.ts';
import {
  CAPTION_ERROR_KEYS,
  MEDIA_EDIT_ERROR_KEYS,
  MESSAGE_FAILURE_KEYS,
  RECAP_ERROR_KEYS,
  SCHEDULED_POST_FAILURE_KEYS,
  captionErrorText,
  isFailureCode,
  mediaEditErrorText,
  recapErrorText,
  scheduledFailureText,
  scheduledPostFailedText,
  storySendFailureText,
} from './job-failures.ts';
import { messagePreviewOf, messagePreviewText, storyReplyLabel } from './message-preview.ts';
import {
  APPEAL_STATUS_KEYS,
  MODERATION_DECISION_KEYS,
  MODERATION_TARGET_KEYS,
  PRODUCT_KIND_KEYS,
  agentSubtitle,
  appealStatusText,
  campaignName,
  moderationCaseText,
  signInNoticeText,
} from './server-text.ts';
import { REPORT_TARGETS } from './constants.ts';
import type { ReasonTranslator } from './feed-reasons.ts';
import type { CaptionErrorCode, MediaEditErrorCode, Message, MessageFailureCode, MessagePreview, RecapErrorCode, ScheduledPostFailureCode } from './types.ts';

const tr = (locale: string): ReasonTranslator => ({ t: (k, v) => t(k, locale, v), tp: (k, n, v) => tp(k, n, locale, v), locale });

describe('the last sentences the API wrote in English', () => {
  // Every code in the unions: adding one without a sentence is a type error here.
  const recap: Record<RecapErrorCode, true> = { source_unavailable: true, items_unavailable: true, items_unreadable: true, render_failed: true, failed: true };
  const edit: Record<MediaEditErrorCode, true> = { source_missing: true, render_failed: true, process_failed: true };
  const caption: Record<CaptionErrorCode, true> = { not_set_up: true, no_sound: true, no_speech: true, too_long: true, failed: true };
  const message: Record<MessageFailureCode, true> = {
    left_chat: true,
    unavailable: true,
    cannot_message: true,
    account_inactive: true,
    account_limited: true,
    verify: true,
    content_blocked: true,
    too_fast: true,
    not_sent: true,
  };
  const post: Record<ScheduledPostFailureCode, true> = {
    media_blocked: true,
    community: true,
    no_plan: true,
    music: true,
    people: true,
    content_blocked: true,
    verify: true,
    too_fast: true,
    check_draft: true,
  };

  it('has a sentence in every language for every code', () => {
    const keys: string[] = [
      ...Object.keys(recap).map((c) => RECAP_ERROR_KEYS[c as RecapErrorCode]),
      ...Object.keys(edit).map((c) => MEDIA_EDIT_ERROR_KEYS[c as MediaEditErrorCode]),
      ...Object.keys(caption).map((c) => CAPTION_ERROR_KEYS[c as CaptionErrorCode]),
      ...Object.keys(message).map((c) => MESSAGE_FAILURE_KEYS[c as MessageFailureCode]),
      ...Object.keys(post).map((c) => SCHEDULED_POST_FAILURE_KEYS[c as ScheduledPostFailureCode]),
      ...REPORT_TARGETS.map((c) => MODERATION_TARGET_KEYS[c]),
      ...Object.values(MODERATION_DECISION_KEYS),
      ...Object.values(APPEAL_STATUS_KEYS),
      ...Object.values(PRODUCT_KIND_KEYS),
      'moderation.case',
      'chat.storyReply.yours',
      'chat.storyReply.theirs',
      'chat.storyReply.quote',
      'chat.storyReply.preview',
      'market.preview.offerAmount',
      'market.preview.counterAmount',
      'ads.boostName',
      'ads.boostNameEmpty',
      'echo.credit',
      'm.recap.onThisDay',
    ];
    for (const locale of SUPPORTED_LOCALES) {
      const missing = keys.filter((k) => !CATALOGS[locale]![k as MessageKey]?.trim());
      expect(missing, locale).toEqual([]);
    }
  });

  it('keeps each translation’s placeholders', () => {
    for (const locale of SUPPORTED_LOCALES)
      for (const key of [
        'chat.storyReply.quote',
        'chat.storyReply.preview',
        'market.preview.offerAmount',
        'ads.boostName',
        'moderation.case',
        'echo.credit',
      ] as const) {
        const want = (t(key, 'en').match(/\{\w+\}/g) ?? []).sort();
        expect((CATALOGS[locale]![key].match(/\{\w+\}/g) ?? []).sort(), `${locale} ${key}`).toEqual(want);
      }
  });

  it('says why a job failed in the reader’s language, or shows what an older API sent', () => {
    expect(recapErrorText({ errorCode: 'items_unavailable', error: 'x' }, tr('en').t)).toBe(
      'None of the photos or videos you chose are available to you any more.',
    );
    expect(recapErrorText({ errorCode: 'render_failed', error: 'x' }, tr('fr').t)).toBe(t('recaps.error.renderFailed', 'fr'));
    expect(recapErrorText({ error: 'Old English' }, tr('fr').t)).toBe('Old English');
    expect(recapErrorText({ error: null }, tr('fr').t)).toBeNull();
    expect(mediaEditErrorText({ errorCode: 'process_failed', error: 'x' }, tr('es').t)).toBe(t('videoEditor.error.processFailed', 'es'));
    expect(captionErrorText({ errorCode: 'no_speech', error: 'x' }, tr('sw').t)).toBe(t('videoEditor.captions.error.noSpeech', 'sw'));
    expect(scheduledFailureText({ failureCode: 'left_chat', failure: 'x' }, tr('en').t)).toBe("You're no longer in this chat.");
    expect(storySendFailureText({ code: 'cannot_message', message: 'x' }, tr('ar').t)).toBe(t('chat.failure.cannotMessage', 'ar'));
    expect(isFailureCode(RECAP_ERROR_KEYS, 'failed')).toBe(true);
    expect(isFailureCode(RECAP_ERROR_KEYS, 'toString')).toBe(false);
  });

  it('says why a scheduled post went back to drafts', () => {
    expect(scheduledPostFailedText({ data: { code: 'community', reason: 'x' } }, tr('en').t)).toBe(
      "A scheduled post couldn't be published, so it's back in your drafts. Join the community again to post in it.",
    );
    expect(scheduledPostFailedText({ data: { reason: 'An older reason.' } }, tr('en').t)).toBe(
      "A scheduled post couldn't be published, so it's back in your drafts. An older reason.",
    );
    expect(scheduledPostFailedText({ data: {} }, tr('en').t)).toBe("A scheduled post couldn't be published, so it's back in your drafts.");
  });
});

describe('message previews', () => {
  const sender = { id: 'u1', username: 'ada', displayName: 'Ada', avatarUrl: null, mode: 'personal' } as unknown as MessagePreview['sender'];
  const base: MessagePreview = { id: 'm1', available: true, sender, body: '', attachmentKind: null, createdAt: null };

  it('says server-made cards from what they are', () => {
    expect(messagePreviewText({ ...base, body: 'Live location', kind: 'location', live: true }, { t: tr('fr').t })).toBe(t('location.live', 'fr'));
    expect(messagePreviewText({ ...base, body: 'Location', kind: 'location' }, { t: tr('fr').t })).toBe(t('location.pin', 'fr'));
    expect(messagePreviewText({ ...base, body: 'Four up', kind: 'game', gameKind: 'four_up' }, { t: tr('en').t })).toBe('Game: Four up');
    const offer = { ...base, body: 'Offer · NGN 5,000.00', kind: 'offer' as const, offer: { amountCents: 500000, currency: 'NGN', counter: false } };
    expect(messagePreviewText(offer, { t: tr('en').t, locale: 'en' })).toMatch(/^Offer · NGN\s5,000.00$/);
    expect(messagePreviewText({ ...offer, offer: { ...offer.offer, counter: true } }, { t: tr('fr').t, locale: 'fr' })).toMatch(
      /^Contre-offre · 5\s000,00\sNGN$/,
    );
    // A stored offer from before the amount was sent: its body.
    expect(messagePreviewText({ ...base, body: 'Offer · $5.00', kind: 'offer' }, { t: tr('fr').t })).toBe('Offer · $5.00');
  });

  it('says whose story a reply answered', () => {
    const reply = { ...base, body: 'So good', storyReply: { quote: null } };
    expect(messagePreviewText(reply, { t: tr('en').t, meId: 'u2' })).toBe('Replied to your story: So good');
    expect(messagePreviewText(reply, { t: tr('en').t, meId: 'u1' })).toBe('You replied to their story: So good');
    expect(messagePreviewText({ ...reply, storyReply: { quote: 'Beach day' } }, { t: tr('fr').t, meId: 'u2' })).toBe('A répondu à « Beach day » : So good');
    expect(storyReplyLabel({ quote: null }, 'u1', 'u2', tr('es').t)).toBe(t('chat.storyReply.yours', 'es'));
    // A reply stored before: its English body as it is.
    expect(messagePreviewText({ ...base, body: 'Replied to your story: hi' }, { t: tr('fr').t })).toBe('Replied to your story: hi');
  });

  it('makes a preview from a whole message', () => {
    const m = {
      id: 'm1',
      conversationId: 'c1',
      sender,
      body: 'Location',
      replyToId: null,
      attachments: [],
      createdAt: '2026-01-01T00:00:00Z',
      location: { mode: 'live' },
    } as unknown as Message;
    expect(messagePreviewOf(m)).toMatchObject({ kind: 'location', live: true });
  });
});

describe('names the API used to write in English', () => {
  it('writes a product’s price and kind for the reader', () => {
    expect(agentSubtitle({ type: 'product', subtitle: '5.00 USD · digital', priceCents: 500, currency: 'USD', productKind: 'digital' }, tr('en'))).toBe(
      '$5.00 · Download',
    );
    expect(agentSubtitle({ type: 'product', priceCents: 500, currency: 'USD', productKind: 'service' }, tr('fr'))).toMatch(/^5,00\s\$US · Service$/);
    expect(agentSubtitle({ type: 'product', subtitle: 'Old' }, tr('fr'))).toBe('Old');
  });

  it('names a boost after its post', () => {
    expect(campaignName({ name: 'Boost: Our new menu', nameCode: 'boost', nameParams: { excerpt: 'Our new menu' } }, tr('fr').t)).toBe('Boost : Our new menu');
    expect(campaignName({ name: 'Boost', nameCode: 'boost', nameParams: { excerpt: '' } }, tr('es').t)).toBe(t('ads.boostNameEmpty', 'es'));
    expect(campaignName({ name: 'Summer sale' }, tr('fr').t)).toBe('Summer sale');
  });

  it('labels decisions about your content and appeals', () => {
    expect(moderationCaseText({ target_type: 'post', decision: 'remove' }, tr('en').t)).toBe('Post: Removed');
    expect(moderationCaseText({ target_type: 'user', decision: 'suspend_user' }, tr('fr').t)).toBe('Ton compte : Compte suspendu');
    expect(moderationCaseText({ target_type: 'new_thing', decision: 'new_decision' }, tr('en').t)).toBe('new thing: new decision');
    expect(appealStatusText('upheld', tr('en').t)).toBe('Your appeal was reviewed. The decision stays.');
    expect(appealStatusText('pending_review', tr('en').t)).toBe('Appeal: pending review');
  });

  it('names the device and place of a sign-in as the API sent them', () => {
    const n = { type: 'new_sign_in', data: { device: 'Chrome on macOS', place: 'Nigeria', deviceLabel: 'Chrome sur macOS', placeLabel: 'Nigéria' } };
    expect(signInNoticeText(n, tr('fr').t)).toBe(t('m.notif.newSignInPlace', 'fr', { device: 'Chrome sur macOS', place: 'Nigéria' }));
    expect(signInNoticeText({ type: 'new_sign_in', data: { device: 'Chrome on macOS', place: null } }, tr('en').t)).toBe(
      'New sign-in to your account from Chrome on macOS.',
    );
    expect(signInNoticeText({ type: 'follow', data: {} }, tr('en').t)).toBeNull();
  });
});
