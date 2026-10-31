'use client';

import { useEffect, useState } from 'react';
import { BottomSheet, Button, Select, TextField } from '@yapilapi/design-system';
import type { MessageKey, Post, StoryPostCard } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import { StoryPostCardView } from '@/components/StoryStickers';

/** Who a post added to your story goes to (as for a reshared story). */
const AUDIENCES = ['followers', 'friends', 'public', 'close_friends'] as const;

/**
 * Whether "Add to your story" is offered for a post: signed in, published and public. The server
 * checks the rest (private accounts, blocks, moderation) and says why when it refuses.
 */
export function canAddToStory(post: Post, signedIn: boolean): boolean {
  return signedIn && !post.status && post.visibility === 'public';
}

/** The card a post will make in a story, from what the app already has (the server builds the real one). */
function previewCard(post: Post): StoryPostCard {
  const m = post.media.find((x) => (x.kind === 'image' || x.kind === 'video') && !x.sensitive);
  return {
    id: post.id,
    available: true,
    author: post.author,
    reel: post.format === 'reel',
    caption:
      post.body
        .split('\n')
        .find((l) => l.trim())
        ?.trim() ?? '',
    mediaUrl: m?.kind === 'image' ? (m.variants?.medium ?? m.url) : null,
    mediaKind: m ? (m.kind as 'image' | 'video') : null,
    posterUrl: m?.kind === 'video' ? (m.posterUrl ?? null) : null,
  };
}

/**
 * "Add to your story" for a post or reel: a preview of the card your story will show, a few
 * words if you like, who sees it, and Share. The card is credited to the post's author and
 * opens the post; it says the post isn't available once it's gone or no longer public.
 */
export function AddToStorySheet({ post, onClose, onAdded }: { post: Post | null; onClose: () => void; onAdded?: (post: Post) => void }) {
  const { t, toast } = useSession();
  const [note, setNote] = useState('');
  const [audience, setAudience] = useState<string>('followers');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (post) setNote('');
  }, [post]);

  async function share() {
    if (!post) return;
    setBusy(true);
    try {
      await api.posts.addToStory(post.id, { body: note.trim(), visibility: audience });
      toast(t('m.stories.added'));
      onAdded?.(post);
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet open={!!post} onClose={onClose} title={t('m.stories.add')}>
      {post ? (
        <div className="stack">
          <div className="add-to-story__preview">
            <StoryPostCardView card={previewCard(post)} preview />
          </div>
          <TextField label={t('m.create.story.body')} value={note} maxLength={500} onChange={(e) => setNote(e.currentTarget.value)} />
          <Select label={t('m.stories.audience')} value={audience} onChange={(e) => setAudience(e.currentTarget.value)}>
            {AUDIENCES.map((v) => (
              <option key={v} value={v}>
                {t(`visibility.${v}` as MessageKey)}
              </option>
            ))}
          </Select>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {t('story.post.hint', { name: post.author.displayName })}
          </p>
          <Button icon="plus" loading={busy} onClick={() => void share()}>
            {t('m.common.share')}
          </Button>
        </div>
      ) : null}
    </BottomSheet>
  );
}
