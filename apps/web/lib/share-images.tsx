/**
 * The share image for each kind of shared link. Anything that isn't public
 * gets the plain site card, so an image never reveals more than the page does.
 */
import { getPublicCommunity, getPublicEvent, getPublicPost, getPublicProfile } from './public';
import { eventWhen, eventWhere } from './metadata';
import { card, embeddableImage, plural, siteCard } from './og';

export async function postShareImage(id: string) {
  const post = await getPublicPost(id);
  if (!post) return siteCard();
  const [avatar, image] = await Promise.all([embeddableImage(post.author.avatarUrl), embeddableImage(post.image?.url)]);
  return card({
    eyebrow: post.format === 'reel' ? 'Reel' : (post.community?.name ?? undefined),
    title: post.author.displayName,
    subtitle: `@${post.author.username}`,
    body: post.locked
      ? `For ${post.author.displayName}'s subscribers. Subscribe on YAPILAPI to see it.`
      : post.excerpt || (post.format === 'reel' ? 'Watch the reel on YAPILAPI.' : 'See the post on YAPILAPI.'),
    avatar: { src: avatar, name: post.author.displayName },
    image,
    footer: `${plural(post.counts.likes, 'like', 'likes')} · ${plural(post.counts.comments, 'comment', 'comments')}`,
  });
}

export async function profileShareImage(username: string) {
  const profile = await getPublicProfile(username);
  if (!profile) return siteCard();
  const avatar = await embeddableImage(profile.avatarUrl);
  return card({
    eyebrow: profile.mode === 'personal' ? undefined : profile.mode[0]!.toUpperCase() + profile.mode.slice(1),
    title: profile.displayName,
    subtitle: `@${profile.username}`,
    body: profile.bio || `See what ${profile.displayName} shares on YAPILAPI.`,
    avatar: { src: avatar, name: profile.displayName },
    footer: [
      plural(profile.counts.followers, 'follower', 'followers'),
      `${plural(profile.counts.following, 'following', 'following')}`,
      plural(profile.counts.posts, 'post', 'posts'),
    ].join(' · '),
  });
}

export async function eventShareImage(id: string) {
  const event = await getPublicEvent(id);
  if (!event) return siteCard();
  return card({
    eyebrow: event.community ? `Event · ${event.community.name}` : 'Event',
    title: event.title,
    subtitle: `${eventWhen(event)} · ${eventWhere(event)}`,
    body: event.excerpt || `Hosted by ${event.host.displayName}.`,
    footer: `Hosted by ${event.host.displayName} · ${plural(event.counts.going, 'person going', 'people going')}`,
  });
}

export async function communityShareImage(slug: string) {
  const community = await getPublicCommunity(slug);
  if (!community) return siteCard();
  return card({
    eyebrow: 'Community',
    title: community.name,
    subtitle: community.topics.length ? community.topics.map((t) => `#${t}`).join('  ') : undefined,
    body: community.excerpt || 'A community on YAPILAPI.',
    footer: plural(community.memberCount, 'member', 'members'),
  });
}
