/**
 * English copy for the Privacy Center (`privacy.*`): what YAPILAPI holds, consents, advertising, visibility overview,
 * data export and connected apps. Blocked/muted/restricted people are already covered by the Connections settings tab;
 * sessions and devices by Security; account deletion by Account. This is the new `/v1/privacy/*` surface only.
 */
export const enPrivacy = {
  'settings.nav.data': 'Your data',

  'privacy.overviewTitle': 'What we hold about you',
  'privacy.overviewLead':
    'A summary of your data, why we keep it, and for how long. Nothing here is hidden from you.',
  'privacy.category.items': '{count} items',
  'privacy.category.purpose': 'Why: {purpose}',
  'privacy.category.retention': 'Kept: {retention}',
  'privacy.retainedTitle': 'Kept even after you delete your account, and why',

  'privacy.consentsTitle': 'What you have allowed',
  'privacy.consentsLead':
    'Each choice is recorded with a timestamp; changing it adds to the trail rather than erasing it.',
  'privacy.consentDefault': 'Default',
  'privacy.consentDecidedAt': 'Decided {when}',
  'privacy.consentTeenLocked': 'Not available for accounts under 18',
  'privacy.consentHistory': 'View history',
  'privacy.consentHistoryTitle': 'Consent history',
  'privacy.consentHistoryEmpty': 'No history yet.',
  'privacy.consentHistoryGranted': 'Turned on',
  'privacy.consentHistoryWithdrawn': 'Turned off',

  'privacy.advertisingTitle': 'Advertising',
  'privacy.personalizedAds': 'Personalised ads',
  'privacy.personalizedAdsHelp': 'Not available for accounts under 18.',
  'privacy.limitSensitive': 'Limit sensitive ad categories',
  'privacy.limitSensitiveTeenLocked': 'Cannot be lowered for accounts under 18',

  'privacy.visibilityTitle': 'Who can see what',
  'privacy.visibilityLead': 'A live summary, derived from your real settings, not a copy of them.',
  'privacy.visibilityPrivate': 'Private account',
  'privacy.visibilityDiscoverable': 'Discoverable in search',
  'privacy.visibilityWhoCanMessage': 'Who can message you: {who}',
  'privacy.visibilityDefaultPost': 'Default post audience: {visibility}',
  'privacy.visibilityPostsByAudience': 'Your posts by audience',
  'privacy.visibilityMomentsByAudience': 'Your moments by audience',
  'privacy.visibilityControls': 'Controls in place',
  'privacy.visibilityBlocked': '{count} blocked',
  'privacy.visibilityMuted': '{count} muted',
  'privacy.visibilityRestricted': '{count} restricted',
  'privacy.visibilityCircles': '{count} circles',
  'privacy.visibilityConnectedApps': '{count} connected apps',
  'privacy.visibilityGuardians': '{count} guardian links',

  'privacy.exportTitle': 'Download your data',
  'privacy.exportLead':
    'A machine-readable copy of your own data (never other people’s). One request every 24 hours.',
  'privacy.exportPasswordLabel': 'Confirm your password',
  'privacy.exportRequest': 'Request export',
  'privacy.exportRequested': 'Export requested. It will be ready shortly.',
  'privacy.exportRequestsTitle': 'Past requests',
  'privacy.exportRequestsEmpty': 'No export requested yet.',
  'privacy.exportStatus.pending': 'Pending',
  'privacy.exportStatus.processing': 'Preparing',
  'privacy.exportStatus.completed': 'Ready',
  'privacy.exportStatus.failed': 'Failed',
  'privacy.exportDownload': 'Download',
  'privacy.exportExpired': 'This export has expired',
  'privacy.exportSectionsTitle': 'What an export includes',

  'privacy.connectedAppsTitle': 'Apps you have authorised',
  'privacy.connectedAppsEmpty': 'You have not authorised any apps.',
  'privacy.connectedAppScopes': 'Access: {scopes}',
  'privacy.connectedAppLastUsed': 'Last used {when}',
  'privacy.connectedAppNeverUsed': 'Never used',
  'privacy.connectedAppRevoke': 'Revoke',
  'privacy.connectedAppRevokeDialogTitle': 'Revoke access?',
  'privacy.connectedAppRevokeDialogBody':
    'This app can no longer access your account; its existing tokens stop working immediately.',
} as const;
