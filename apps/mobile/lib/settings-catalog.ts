import type { Href } from 'expo-router';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import type { IconName } from './ui';

/**
 * Settings on the phone, as the Settings home lists them (the same sections as the web). Most
 * open /settings/<id>; Your data and Purchases have their own screens already. The search box
 * also finds the settings inside each section (SETTINGS).
 */
export type SectionId =
  'account' | 'notifications' | 'feed' | 'privacy' | 'security' | 'safety' | 'data-saver' | 'language' | 'appearance' | 'your-data' | 'purchases' | 'help';

export interface Section {
  id: SectionId;
  icon: IconName;
  title: MessageKey;
  desc: MessageKey;
  href: Href;
}

const at = (id: SectionId): Href => ({ pathname: '/settings/[section]', params: { section: id } });

export const SECTIONS: Record<SectionId, Section> = {
  account: { id: 'account', icon: 'person-outline', title: 'st.account.title', desc: 'st.account.desc', href: at('account') },
  notifications: {
    id: 'notifications',
    icon: 'notifications-outline',
    title: 'st.notifications.title',
    desc: 'st.notifications.desc',
    href: at('notifications'),
  },
  feed: { id: 'feed', icon: 'pulse-outline', title: 'st.feed.title', desc: 'st.feed.desc', href: at('feed') },
  privacy: { id: 'privacy', icon: 'lock-closed-outline', title: 'st.privacy.title', desc: 'st.privacy.desc', href: at('privacy') },
  security: { id: 'security', icon: 'key-outline', title: 'st.security.title', desc: 'st.security.desc', href: at('security') },
  safety: { id: 'safety', icon: 'shield-checkmark-outline', title: 'st.safety.title', desc: 'st.safety.desc', href: at('safety') },
  'data-saver': { id: 'data-saver', icon: 'cellular-outline', title: 'dataSaver.title', desc: 'st.dataSaver.desc', href: at('data-saver') },
  language: { id: 'language', icon: 'language-outline', title: 'st.language.title', desc: 'st.language.desc', href: at('language') },
  appearance: { id: 'appearance', icon: 'color-palette-outline', title: 'st.appearance.title', desc: 'st.appearance.desc', href: at('appearance') },
  'your-data': { id: 'your-data', icon: 'server-outline', title: 'settings.data.title', desc: 'st.yourData.desc', href: '/your-data' },
  purchases: { id: 'purchases', icon: 'bag-handle-outline', title: 'm.purchases.title', desc: 'st.purchases.desc', href: '/purchases' },
  help: { id: 'help', icon: 'help-circle-outline', title: 'st.help.title', desc: 'st.help.desc', href: at('help') },
};

export const GROUPS: { title: MessageKey; sections: SectionId[] }[] = [
  { title: 'st.group.account', sections: ['account', 'security', 'your-data'] },
  { title: 'st.group.use', sections: ['notifications', 'feed', 'privacy', 'safety'] },
  { title: 'st.group.app', sections: ['appearance', 'language', 'data-saver'] },
  { title: 'st.group.more', sections: ['purchases', 'help'] },
];

/** Settings inside the sections, for search. */
export const SETTINGS: { label: MessageKey; section: SectionId }[] = [
  { label: 'profile.edit', section: 'account' },
  { label: 'auth.username', section: 'account' },
  { label: 'auth.email', section: 'account' },
  { label: 'm.verify.phone', section: 'account' },
  { label: 'auth.birthDate', section: 'account' },
  { label: 'st.password.title', section: 'security' },
  { label: 'settings.twoStep.title', section: 'security' },
  { label: 'settings.passkeys.title', section: 'security' },
  { label: 'settings.sessions.title', section: 'security' },
  { label: 'st.logoutAll', section: 'security' },
  { label: 'st.activity.title', section: 'security' },
  { label: 'settings.apps.title', section: 'security' },
  { label: 'm.push.enable', section: 'notifications' },
  { label: 'st.pause.title', section: 'notifications' },
  { label: 'st.quiet.title', section: 'notifications' },
  { label: 'st.categories.title', section: 'notifications' },
  { label: 'settings.friendsOnly', section: 'feed' },
  { label: 'settings.reducedRecs', section: 'feed' },
  { label: 'settings.focusMode', section: 'feed' },
  { label: 'settings.budget', section: 'feed' },
  { label: 'settings.private', section: 'privacy' },
  { label: 'st.who.message', section: 'privacy' },
  { label: 'st.who.comment', section: 'privacy' },
  { label: 'st.who.mention', section: 'privacy' },
  { label: 'm.tagging.title', section: 'privacy' },
  { label: 'm.closeFriends.title', section: 'privacy' },
  { label: 'm.circles.title', section: 'privacy' },
  { label: 'm.archive.title', section: 'privacy' },
  { label: 'settings.blocked.title', section: 'privacy' },
  { label: 'st.muted.title', section: 'privacy' },
  { label: 'hiddenWords.title', section: 'privacy' },
  { label: 'sharing.title', section: 'privacy' },
  { label: 'settings.dataUse.title', section: 'privacy' },
  { label: 'm.ads.title', section: 'privacy' },
  { label: 'm.family.title', section: 'safety' },
  { label: 'st.restricted.title', section: 'safety' },
  { label: 'st.sensitive.title', section: 'safety' },
  { label: 'settings.language', section: 'language' },
  { label: 'translate.settingsTitle', section: 'language' },
  { label: 'privacy.export', section: 'your-data' },
  { label: 'privacy.delete', section: 'your-data' },
  { label: 'st.problem.title', section: 'help' },
  { label: 'legal.title', section: 'help' },
  { label: 'st.about.title', section: 'help' },
  { label: 'plus.title', section: 'purchases' },
];
