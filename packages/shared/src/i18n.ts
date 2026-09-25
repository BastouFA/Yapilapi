/**
 * Message catalogs. Every user-facing string in the apps goes through t().
 * Add a locale by adding a catalog with the same keys; missing keys fall back to English.
 */
const en = {
  'app.tagline': 'Your social world. One place.',
  'nav.home': 'Home',
  'nav.discover': 'Discover',
  'nav.create': 'Create',
  'nav.inbox': 'Inbox',
  'nav.profile': 'Profile',
  'auth.signup.title': 'Join YAPILAPI',
  'auth.signup.submit': 'Create account',
  'auth.login.title': 'Log in',
  'auth.login.submit': 'Log in',
  'auth.logout': 'Log out',
  'auth.email': 'Email address',
  'auth.password': 'Password',
  'auth.password.hint': 'At least 10 characters.',
  'auth.username': 'Username',
  'auth.displayName': 'Name',
  'auth.haveAccount': 'Already have an account?',
  'auth.noAccount': 'New to YAPILAPI?',
  'auth.forgot': 'Forgot password?',
  'onboarding.interests.title': 'What are you into?',
  'onboarding.interests.body': 'Pick at least three. This shapes Discover and your For You feed, and you can change it any time.',
  'onboarding.follow.title': 'Follow a few people',
  'onboarding.continue': 'Continue',
  'onboarding.finish': 'Go to Home',
  'feed.for_you': 'For you',
  'feed.following': 'Following',
  'feed.friends': 'Friends',
  'feed.communities': 'Communities',
  'feed.local': 'Local',
  'feed.empty': 'Nothing here yet. Follow people or join a community to fill your feed.',
  'feed.end': "You're all caught up.",
  'feed.loadMore': 'Load more',
  'post.like': 'Like',
  'post.unlike': 'Unlike',
  'post.comment': 'Comment',
  'post.comments': 'Comments',
  'post.save': 'Save',
  'post.report': 'Report',
  'post.delete': 'Delete post',
  'post.why': 'Why am I seeing this?',
  'post.lessLikeThis': 'Show less like this',
  'post.moreLikeThis': 'Show more like this',
  'post.notInterested': 'Not interested',
  'post.muteCreator': 'Mute this person',
  'post.aiAssisted': 'Made with AI assistance',
  'comment.placeholder': 'Write a comment',
  'comment.submit': 'Post comment',
  'create.title': 'Create',
  'create.placeholder': "What's happening?",
  'create.visibility': 'Who can see this',
  'create.publish': 'Publish',
  'create.published': 'Published',
  'create.aiCaption': 'Suggest a caption',
  'visibility.public': 'Everyone',
  'visibility.followers': 'Followers',
  'visibility.friends': 'Friends',
  'visibility.circle': 'A circle',
  'visibility.selected': 'Selected people',
  'visibility.private': 'Only me',
  'profile.follow': 'Follow',
  'profile.unfollow': 'Following',
  'profile.message': 'Message',
  'profile.addFriend': 'Add friend',
  'profile.requestSent': 'Request sent',
  'profile.acceptFriend': 'Accept request',
  'profile.friends': 'Friends',
  'profile.followers': 'Followers',
  'profile.following': 'Following',
  'profile.posts': 'Posts',
  'profile.edit': 'Edit profile',
  'profile.block': 'Block',
  'profile.unblock': 'Unblock',
  'inbox.title': 'Inbox',
  'inbox.empty': 'No conversations yet. Message someone from their profile.',
  'inbox.newGroup': 'New group',
  'inbox.placeholder': 'Write a message',
  'inbox.send': 'Send',
  'inbox.summarize': 'Summarize',
  'discover.title': 'Discover',
  'discover.search': 'Search people, communities, events, places',
  'discover.people': 'People',
  'discover.communities': 'Communities',
  'discover.events': 'Events',
  'discover.places': 'Places',
  'discover.posts': 'Posts',
  'discover.products': 'Products',
  'discover.now': 'Happening now',
  'communities.title': 'Communities',
  'communities.create': 'Create community',
  'communities.join': 'Join',
  'communities.joined': 'Joined',
  'communities.leave': 'Leave',
  'communities.members': 'members',
  'events.title': 'Events',
  'events.create': 'Create event',
  'events.going': 'Going',
  'events.interested': 'Interested',
  'events.notGoing': "Can't go",
  'notifications.title': 'Notifications',
  'privacy.title': 'Privacy center',
  'privacy.export': 'Download my data',
  'privacy.delete': 'Delete my account',
  'error.generic': 'Something went wrong. Try again.',
  'error.network': "Can't reach YAPILAPI. Check your connection and try again.",
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.saved': 'Saved',
  'common.loading': 'Loading',
  'common.devData': 'Development data',
} as const;

export type MessageKey = keyof typeof en;
type Catalog = Partial<Record<MessageKey, string>>;

const fr: Catalog = {
  'app.tagline': 'Ton monde social. Un seul endroit.',
  'nav.home': 'Accueil',
  'nav.discover': 'Découvrir',
  'nav.create': 'Créer',
  'nav.inbox': 'Messages',
  'nav.profile': 'Profil',
  'auth.login.title': 'Se connecter',
  'auth.login.submit': 'Se connecter',
  'auth.signup.title': 'Rejoindre YAPILAPI',
  'auth.signup.submit': 'Créer un compte',
  'feed.for_you': 'Pour toi',
  'feed.following': 'Abonnements',
  'feed.friends': 'Amis',
  'post.like': "J'aime",
  'post.comment': 'Commenter',
  'create.publish': 'Publier',
};

const ar: Catalog = {
  'app.tagline': 'عالمك الاجتماعي. في مكان واحد.',
  'nav.home': 'الرئيسية',
  'nav.discover': 'اكتشف',
  'nav.create': 'إنشاء',
  'nav.inbox': 'الرسائل',
  'nav.profile': 'الملف الشخصي',
};

export const CATALOGS: Record<string, Catalog> = { en, fr, ar };
export const SUPPORTED_LOCALES = Object.keys(CATALOGS);
export const RTL_LOCALES = new Set(['ar', 'he', 'fa', 'ur']);

export function t(key: MessageKey, locale = 'en', vars?: Record<string, string | number>): string {
  const base = locale.split('-')[0] ?? 'en';
  let s: string = CATALOGS[locale]?.[key] ?? CATALOGS[base]?.[key] ?? en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

export function isRtl(locale: string): boolean {
  return RTL_LOCALES.has(locale.split('-')[0] ?? '');
}

export function formatRelativeTime(date: Date | string, locale = 'en', now = new Date()): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const diff = (d.getTime() - now.getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day');
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(d);
}

export function formatMoney(cents: number, currency: string, locale = 'en'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}
