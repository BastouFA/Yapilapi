// Yap's build settings, the same way as apps/mobile/app.config.js: the API and web addresses come
// from the build (eas.json sets YAPILAPI_API_URL and YAPILAPI_WEB_URL per profile) and default to
// the development servers in app.json. Yap uses the same accounts, API and chats as YAPILAPI.
//
// Not set yet: web links that open Yap (associatedDomains / Android app links). The web site's
// .well-known files name YAPILAPI's app only, and both apps claiming the same paths would fight
// over them; chat links open YAPILAPI (or the web) until the web serves Yap's /yap paths too.
const fs = require('fs');
const path = require('path');

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1|[^/]*\.local\b)/i;

module.exports = ({ config }) => {
  const env = process.env.YAPILAPI_APP_ENV ?? 'development';
  const apiUrl = (process.env.YAPILAPI_API_URL || config.extra.apiUrl).replace(/\/+$/, '');
  const webUrl = (process.env.YAPILAPI_WEB_URL || config.extra.webUrl).replace(/\/+$/, '');
  const wsUrl = process.env.YAPILAPI_WS_URL || undefined;
  const projectId = process.env.EAS_PROJECT_ID || config.extra.eas.projectId;
  const localServices = path.join(__dirname, 'secrets', 'google-services.json');
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON || (fs.existsSync(localServices) ? './secrets/google-services.json' : undefined);

  // A store build must never point at a development machine, or ship without push.
  if (env === 'production') {
    if (LOCAL.test(apiUrl) || LOCAL.test(webUrl) || !/^https:/.test(apiUrl) || !/^https:/.test(webUrl))
      throw new Error('Production builds need YAPILAPI_API_URL and YAPILAPI_WEB_URL set to https addresses (eas.json, build.production.env).');
    if (wsUrl && !/^wss:/.test(wsUrl)) throw new Error('YAPILAPI_WS_URL must be a wss:// address in production builds.');
    if (!projectId) throw new Error('Production builds need EAS_PROJECT_ID (run `eas init` in apps/yap and set it in the production environment).');
    if (process.env.EAS_BUILD_PLATFORM === 'android' && !googleServicesFile)
      throw new Error('Android production builds need GOOGLE_SERVICES_JSON for push (eas env:create --type file, see docs/operations/real-device-testing.md).');
  }

  const android = { ...config.android, ...(googleServicesFile ? { googleServicesFile } : {}) };

  return {
    ...config,
    android,
    extra: { ...config.extra, apiUrl, webUrl, ...(wsUrl ? { wsUrl } : {}), appEnv: env, eas: { ...config.extra.eas, projectId } },
  };
};
