'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AIPanel, Button } from '@yapilapi/design-system';
import type { CaptionIdeas, CatchUp, CatchUpOffer, MessageKey, SmartReplies } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

/**
 * AI helpers on the web: Catch me up on Pulse, suggested replies in chats, "Suggest a
 * description" for photos and caption ideas. Everything they show is labelled
 * AI-generated, and nothing is posted or sent until the person does it themselves.
 */

/** The small print under AI output: the dev stand-in's mark, or the held-back note, then the feature's own note. */
function useAiNotice() {
  const { t } = useSession();
  return (r: { provider?: string; notice?: string } | null | undefined, extra?: string) =>
    [r?.provider === 'dev' ? t('ai.devNotice') : null, r?.notice && r.provider !== 'dev' ? t('ai.held') : null, extra].filter(Boolean).join(' ');
}

const SECTION_TITLE: Record<CatchUp['sections'][number]['kind'], MessageKey> = {
  moments: 'catchUp.section.moments',
  plans: 'catchUp.section.plans',
  popular: 'catchUp.section.popular',
};

/**
 * Pulse: after 12 hours or more away, a card offers "Catch me up": a short summary of what
 * your friends and the people you follow shared since, each line linking to its posts.
 */
export function CatchUpCard() {
  const { t, tp, flags, toast } = useSession();
  const notice = useAiNotice();
  const [offer, setOffer] = useState<CatchUpOffer | null>(null);
  const [catchUp, setCatchUp] = useState<CatchUp | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!flags.AI_CATCH_UP) return;
    api.ai.pulseVisit().then(setOffer, () => {});
  }, [flags.AI_CATCH_UP]);

  if (hidden || !offer?.offer) return null;

  async function open() {
    setLoading(true);
    try {
      setCatchUp((await api.ai.catchUp()).catchUp);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  if (!catchUp)
    return (
      <AIPanel
        title={t('catchUp.title')}
        label={t('ai.label')}
        loading={loading}
        actions={
          <>
            <Button size="sm" icon="sparkle" loading={loading} onClick={() => void open()}>
              {t('catchUp.title')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setHidden(true);
                void api.ai.dismissCatchUp().catch(() => {});
              }}
            >
              {t('catchUp.notNow')}
            </Button>
          </>
        }
      >
        {tp('catchUp.offer', offer.postCount ?? 0)}
      </AIPanel>
    );

  return (
    <AIPanel
      title={t('catchUp.heading')}
      label={t('ai.label')}
      notice={notice(catchUp, t('catchUp.note'))}
      actions={
        <Button size="sm" variant="ghost" onClick={() => setHidden(true)}>
          {t('catchUp.hide')}
        </Button>
      }
    >
      {catchUp.sections.length ? (
        <div className="catchup">
          {catchUp.sections.map((s) => (
            <section key={s.kind} className="catchup__section" aria-labelledby={`catchup-${s.kind}`}>
              <h2 id={`catchup-${s.kind}`} className="catchup__title">
                {t(SECTION_TITLE[s.kind])}
              </h2>
              <ul className="catchup__lines">
                {s.lines.map((l, i) => (
                  <li key={i}>
                    <span dir="auto">{l.text}</span>{' '}
                    {l.posts.map((p) => (
                      <Link key={p.id} href={`/p/${p.id}`} className="catchup__link">
                        <bdi>{t('catchUp.openPost', { name: p.authorName })}</bdi>
                      </Link>
                    ))}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        t('catchUp.empty')
      )}
    </AIPanel>
  );
}

/**
 * Up to three suggested replies under the last message you received. Tapping one puts it in
 * the message box; it's only sent when you send it. Asked for again when a new message arrives.
 */
export function SmartReplyChips({
  conversationId,
  lastMessageId,
  enabled,
  onPick,
}: {
  conversationId: string;
  /** The newest message in the chat (from anyone): suggestions follow it. */
  lastMessageId: string | null;
  enabled: boolean;
  onPick: (text: string) => void;
}) {
  const { t, flags } = useSession();
  const [replies, setReplies] = useState<SmartReplies | null>(null);
  useEffect(() => {
    setReplies(null);
    if (!enabled || !flags.AI_SMART_REPLIES || !lastMessageId) return;
    let live = true;
    api.conversations.smartReplies(conversationId).then(
      (r) => live && setReplies(r),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [conversationId, lastMessageId, enabled, flags.AI_SMART_REPLIES]);
  if (!replies?.suggestions.length) return null;
  return (
    <div className="smart-replies" role="group" aria-label={`${t('smartReplies.label')}, ${t('ai.label')}`}>
      <span className="smart-replies__label" aria-hidden>
        {t('ai.label')}
      </span>
      {replies.suggestions.map((s) => (
        <button
          key={s}
          type="button"
          className="smart-replies__chip"
          lang={replies.language ?? undefined}
          dir="auto"
          title={t('smartReplies.hint')}
          onClick={() => {
            onPick(s);
            setReplies(null);
          }}
        >
          <span className="smart-replies__text">{s}</span>
        </button>
      ))}
    </div>
  );
}

/** "Suggest a description" for one of your photos: the suggestion goes in the field, to edit before posting. */
export function SuggestAltText({
  mediaId,
  index,
  onSuggested,
  compact,
}: {
  mediaId: string;
  index: number;
  onSuggested: (text: string) => void;
  /** Just the icon (narrow thumbnails); the name is still read out and shown on hover. */
  compact?: boolean;
}) {
  const { t, flags, toast } = useSession();
  const [busy, setBusy] = useState(false);
  if (!flags.AI_ALT_TEXT) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      icon="sparkle"
      loading={busy}
      title={compact ? t('altText.suggest') : undefined}
      aria-label={t('altText.suggestFor', { number: index + 1 })}
      onClick={async () => {
        setBusy(true);
        try {
          const { suggestion } = await api.ai.altText(mediaId);
          if (suggestion.text) {
            onSuggested(suggestion.text);
            toast(suggestion.provider === 'dev' ? `${t('altText.suggested')} ${t('ai.devNotice')}` : t('altText.suggested'));
          } else toast(t('altText.none'));
        } catch (e) {
          toast(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {compact ? null : t('altText.suggest')}
    </Button>
  );
}

/** Caption ideas and hashtags people already use: "Use this" replaces the text, a tag is added to it. Nothing is posted. */
export function CaptionIdeasPanel({
  ideas,
  onUse,
  onAddTag,
  onClose,
}: {
  ideas: CaptionIdeas;
  onUse: (caption: string) => void;
  onAddTag: (tag: string) => void;
  onClose: () => void;
}) {
  const { t } = useSession();
  const notice = useAiNotice();
  const [added, setAdded] = useState<string[]>([]);
  return (
    <AIPanel
      title={t('captions.title')}
      label={t('ai.label')}
      notice={notice(ideas, t('captions.note'))}
      actions={
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t('compose.dismiss')}
        </Button>
      }
    >
      {ideas.captions.length ? (
        <ul className="caption-ideas">
          {ideas.captions.map((c) => (
            <li key={c}>
              <span dir="auto">{c}</span>
              <Button size="sm" variant="secondary" onClick={() => onUse(c)}>
                {t('compose.useThis')}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        t('captions.none')
      )}
      {ideas.hashtags.length ? (
        <div className="stack-sm" style={{ marginTop: 8 }}>
          <span className="yp-field__label">{t('captions.hashtags')}</span>
          <div className="smart-replies">
            {ideas.hashtags.map((tag) => (
              <button
                key={tag}
                type="button"
                className="smart-replies__chip"
                disabled={added.includes(tag)}
                aria-label={t('captions.addTag', { tag })}
                onClick={() => {
                  onAddTag(tag);
                  setAdded((a) => [...a, tag]);
                }}
              >
                <bdi className="smart-replies__text">#{tag}</bdi>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </AIPanel>
  );
}
