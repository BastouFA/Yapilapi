'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button, Card, EmptyState, Skeleton, TextField } from '@yapilapi/design-system';
import type { FaqEntry } from '@yapilapi/api-client';
import type { Post } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

/** Community FAQ: everyone who can see the community reads it; moderators add and remove entries. */
export function CommunityFaq({ slug }: { slug: string }) {
  const { toast } = useSession();
  const [data, setData] = useState<{ items: FaqEntry[]; canEdit: boolean } | null>(null);
  const [q, setQ] = useState('');
  const [a, setA] = useState('');
  const [saving, setSaving] = useState(false);
  const load = () =>
    api.communities.faq(slug).then(setData, (e) => {
      setData({ items: [], canEdit: false });
      toast(errorMessage(e));
    });
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  if (!data) return <Skeleton height={120} />;
  return (
    <div className="stack">
      {data.items.length ? (
        <div className="faq">
          {data.items.map((f) => (
            <details key={f.id} className="faq__item">
              <summary>{f.question}</summary>
              <p>{f.answer}</p>
              {data.canEdit ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await api.communities.deleteFaq(slug, f.id);
                      await load();
                    } catch (e) {
                      toast(errorMessage(e));
                    }
                  }}
                >
                  Remove
                </Button>
              ) : null}
            </details>
          ))}
        </div>
      ) : (
        <EmptyState title="No FAQ yet" body={data.canEdit ? 'Add the questions members ask most.' : 'Moderators can add answers to common questions here.'} />
      )}
      {data.canEdit ? (
        <Card title="Add a question">
          <form
            className="stack-sm"
            onSubmit={async (e) => {
              e.preventDefault();
              setSaving(true);
              try {
                await api.communities.addFaq(slug, { question: q, answer: a });
                setQ('');
                setA('');
                toast('Added to the FAQ');
                await load();
              } catch (err) {
                toast(errorMessage(err));
              } finally {
                setSaving(false);
              }
            }}
          >
            <TextField label="Question" value={q} onChange={(e) => setQ(e.currentTarget.value)} minLength={5} maxLength={300} required />
            <TextField label="Answer" multiline value={a} onChange={(e) => setA(e.currentTarget.value)} maxLength={4000} required />
            <Button type="submit" size="sm" loading={saving} disabled={q.trim().length < 5 || !a.trim()}>
              Add to FAQ
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * While someone writes a post in a community, show FAQ answers and earlier
 * posts that look like the same question, so they can find the answer first.
 */
export function SimilarQuestions({ slug, text }: { slug: string; text: string }) {
  const [res, setRes] = useState<{ faq: (FaqEntry & { score: number })[]; posts: { post: Post; score: number }[] } | null>(null);
  useEffect(() => {
    const q = text.trim();
    if (q.length < 12) {
      setRes(null);
      return;
    }
    const id = setTimeout(() => {
      api.communities.similar(slug, q.slice(0, 500)).then(setRes, () => setRes(null));
    }, 450);
    return () => clearTimeout(id);
  }, [slug, text]);

  if (!res || (!res.faq.length && !res.posts.length)) return null;
  return (
    <section className="similar" aria-live="polite" aria-label="Similar questions">
      <strong>This may already be answered</strong>
      {res.faq.map((f) => (
        <details key={f.id}>
          <summary>{f.question}</summary>
          <p>{f.answer}</p>
        </details>
      ))}
      {res.posts.map(({ post }) => (
        <Link key={post.id} href={`/p/${post.id}`} className="similar__post">
          <span>{post.body.length > 120 ? `${post.body.slice(0, 120)}…` : post.body}</span>
          <span className="muted">
            {post.author.displayName} · {post.counts.comments} {post.counts.comments === 1 ? 'reply' : 'replies'}
          </span>
        </Link>
      ))}
    </section>
  );
}
