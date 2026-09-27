import type { IconName } from '@yapilapi/design-system';
import type { MessageKey } from '@yapilapi/shared';

/**
 * Settings, as the home page lists them: each section has its own page under /settings. The
 * search box on the home page also finds the settings inside each page (SETTINGS below), and
 * opens the page at that setting.
 */
export type SectionId =
  'account' | 'notifications' | 'feed' | 'privacy' | 'security' | 'safety' | 'data-saver' | 'language' | 'appearance' | 'your-data' | 'purchases' | 'help';

export interface Section {
  id: SectionId;
  icon: IconName;
  title: MessageKey;
  desc: MessageKey;
}

export const SECTIONS: Record<SectionId, Section> = {
  account: { id: 'account', icon: 'user', title: 'st.account.title', desc: 'st.account.desc' },
  notifications: { id: 'notifications', icon: 'bell', title: 'st.notifications.title', desc: 'st.notifications.desc' },
  feed: { id: 'feed', icon: 'pulse', title: 'st.feed.title', desc: 'st.feed.desc' },
  privacy: { id: 'privacy', icon: 'lock', title: 'st.privacy.title', desc: 'st.privacy.desc' },
  security: { id: 'security', icon: 'key', title: 'st.security.title', desc: 'st.security.desc' },
  safety: { id: 'safety', icon: 'shield', title: 'st.safety.title', desc: 'st.safety.desc' },
  'data-saver': { id: 'data-saver', icon: 'signal', title: 'dataSaver.title', desc: 'st.dataSaver.desc' },
  language: { id: 'language', icon: 'globe', title: 'st.language.title', desc: 'st.language.desc' },
  appearance: { id: 'appearance', icon: 'palette', title: 'st.appearance.title', desc: 'st.appearance.desc' },
  'your-data': { id: 'your-data', icon: 'database', title: 'settings.data.title', desc: 'st.yourData.desc' },
  purchases: { id: 'purchases', icon: 'bag', title: 'm.purchases.title', desc: 'st.purchases.desc' },
  help: { id: 'help', icon: 'help', title: 'st.help.title', desc: 'st.help.desc' },
};

/** The home page's groups, in order. */
export const GROUPS: { title: MessageKey; sections: SectionId[] }[] = [
  { title: 'st.group.account', sections: ['account', 'security', 'your-data'] },
  { title: 'st.group.use', sections: ['notifications', 'feed', 'privacy', 'safety'] },
  { title: 'st.group.app', sections: ['appearance', 'language', 'data-saver'] },
  { title: 'st.group.more', sections: ['purchases', 'help'] },
];

/** Settings inside the pages, for search. `anchor` is the id the page gives that setting. */
export const SETTINGS: { label: MessageKey; section: SectionId; anchor?: string }[] = [
  { label: 'settings.changePhoto', section: 'account', anchor: 'profile' },
  { label: 'auth.displayName', section: 'account', anchor: 'profile' },
  { label: 'settings.bio', section: 'account', anchor: 'profile' },
  { label: 'settings.profileType', section: 'account', anchor: 'profile' },
  { label: 'auth.username', section: 'account', anchor: 'sign-in' },
  { label: 'auth.email', section: 'account', anchor: 'verification' },
  { label: 'm.verify.phone', section: 'account', anchor: 'verification' },
  { label: 'auth.birthDate', section: 'account', anchor: 'sign-in' },
  { label: 'st.password.title', section: 'security', anchor: 'password' },
  { label: 'settings.twoStep.title', section: 'security', anchor: 'two-step' },
  { label: 'settings.passkeys.title', section: 'security', anchor: 'passkeys' },
  { label: 'settings.sessions.title', section: 'security', anchor: 'sessions' },
  { label: 'st.logoutAll', section: 'security', anchor: 'sessions' },
  { label: 'st.activity.title', section: 'security', anchor: 'activity' },
  { label: 'settings.apps.title', section: 'security', anchor: 'apps' },
  { label: 'settings.push.title', section: 'notifications', anchor: 'push' },
  { label: 'st.pause.title', section: 'notifications', anchor: 'pause' },
  { label: 'st.quiet.title', section: 'notifications', anchor: 'quiet' },
  { label: 'st.categories.title', section: 'notifications', anchor: 'categories' },
  { label: 'settings.friendsOnly', section: 'feed' },
  { label: 'settings.reducedRecs', section: 'feed' },
  { label: 'settings.focusMode', section: 'feed' },
  { label: 'settings.quietMode', section: 'feed' },
  { label: 'settings.budget', section: 'feed' },
  { label: 'settings.private', section: 'privacy', anchor: 'private' },
  { label: 'st.who.message', section: 'privacy', anchor: 'reach' },
  { label: 'st.who.comment', section: 'privacy', anchor: 'reach' },
  { label: 'st.who.mention', section: 'privacy', anchor: 'reach' },
  { label: 'settings.tags.who', section: 'privacy', anchor: 'reach' },
  { label: 'm.closeFriends.title', section: 'privacy', anchor: 'close-friends' },
  { label: 'settings.circles.title', section: 'privacy', anchor: 'close-friends' },
  { label: 'settings.archive.title', section: 'privacy', anchor: 'close-friends' },
  { label: 'settings.blocked.title', section: 'privacy', anchor: 'blocked' },
  { label: 'st.muted.title', section: 'privacy', anchor: 'muted' },
  { label: 'hiddenWords.title', section: 'privacy', anchor: 'hidden-words' },
  { label: 'sharing.title', section: 'privacy', anchor: 'sharing' },
  { label: 'settings.dataUse.title', section: 'privacy', anchor: 'data-use' },
  { label: 'settings.memory.title', section: 'privacy', anchor: 'memory' },
  { label: 'm.family.title', section: 'safety', anchor: 'family' },
  { label: 'st.restricted.title', section: 'safety', anchor: 'restricted' },
  { label: 'st.sensitive.title', section: 'safety', anchor: 'sensitive' },
  { label: 'settings.moderation.title', section: 'safety', anchor: 'moderation' },
  { label: 'settings.language', section: 'language', anchor: 'language' },
  { label: 'settings.country', section: 'language', anchor: 'language' },
  { label: 'translate.settingsTitle', section: 'language', anchor: 'translation' },
  { label: 'privacy.export', section: 'your-data', anchor: 'download' },
  { label: 'privacy.delete', section: 'your-data', anchor: 'delete' },
  { label: 'settings.held.title', section: 'your-data', anchor: 'held' },
  { label: 'st.problem.title', section: 'help', anchor: 'problem' },
  { label: 'legal.title', section: 'help', anchor: 'legal' },
  { label: 'st.about.title', section: 'help', anchor: 'about' },
  { label: 'plus.title', section: 'purchases' },
];

/** Where the old tabbed page's links (?tab=… and #…) point now. */
export function legacySettingsHref(tab: string | null, hash: string): string | null {
  const byHash: Record<string, string> = {
    moderation: '/settings/safety#moderation',
    'close-friends': '/settings/privacy#close-friends',
    verification: '/settings/account#verification',
    'data-saver': '/settings/data-saver',
    translation: '/settings/language#translation',
  };
  const byTab: Record<string, string> = {
    profile: '/settings/account',
    attention: '/settings/notifications',
    privacy: '/settings/privacy',
    security: '/settings/security',
    safety: '/settings/safety',
  };
  const h = hash.replace(/^#/, '');
  return byHash[h] ?? (tab ? (byTab[tab] ?? null) : null);
}
