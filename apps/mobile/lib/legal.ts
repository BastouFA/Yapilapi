import { Linking } from 'react-native';
import type { LegalSlug } from '../../../packages/shared/src/legal';
import { webUrl } from './api';

/**
 * The legal and policy pages live on the web (/legal/<slug>, public, no sign-in), so there is one
 * version to review and keep current. The app opens them in the phone's browser.
 */
export const legalUrl = (slug?: LegalSlug) => `${webUrl}/legal${slug ? `/${slug}` : ''}`;

export const openLegal = (slug?: LegalSlug) => Linking.openURL(legalUrl(slug)).catch(() => {});
