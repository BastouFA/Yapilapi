export const SETTINGS_SECTIONS = [
  'profile',
  'privacy',
  'attention',
  'display',
  'security',
  'connections',
  'account',
  'data',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
