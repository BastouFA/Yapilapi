// Build-time settings on top of app.json. Local development uses app.json as it is. EAS builds
// read these environment variables from eas.json (the build profile's "env") and from the EAS
// environment it names ("development", "preview" or "production"). See docs/operations/app-store.md
// and docs/operations/real-device-testing.md.
//
//   YAPILAPI_API_URL      the API the app talks to, e.g. https://yapilapi-api.onrender.com
//   YAPILAPI_WEB_URL      the web app, for shared links, checkout and the legal pages, e.g. https://yapilapi-web.onrender.com
//   YAPILAPI_WS_URL       optional: the realtime socket, when it isn't the API address with wss:// (…/v1/realtime)
//   EAS_PROJECT_ID        from `eas init` (push notifications need it)
//   GOOGLE_SERVICES_JSON  Firebase's google-services.json, for push on Android (an EAS file variable);
//                         a local build uses secrets/google-services.json when it is there
//   YAPILAPI_APP_ENV      development, preview or production (set by eas.json)
//
// None of these is a secret. When the web address is a real https site (not this computer), the
// build also says which of its links open the app: iOS associated domains and an Android App Links
// intent filter, for the paths in packages/shared/src/app-links.json. The web app serves the files
// the phones check (apps/web/app/.well-known), once APPLE_TEAM_ID and ANDROID_CERT_SHA256 are set on it.
const fs = require('fs');
const path = require('path');
const appLinks = require('../../packages/shared/src/app-links.json');

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
    if (!projectId) throw new Error('Production builds need EAS_PROJECT_ID (run `eas init` and set it in the production environment).');
    if (process.env.EAS_BUILD_PLATFORM === 'android' && !googleServicesFile)
      throw new Error('Android production builds need GOOGLE_SERVICES_JSON for push (eas env:create --type file, see docs/operations/real-device-testing.md).');
  }

  // Links on the web site that open the app. Only for a real https site: a phone can't check a
  // development machine, and iOS would refuse to sign a build that names one.
  const host = /^https:\/\//.test(webUrl) && !LOCAL.test(webUrl) ? new URL(webUrl).host : null;
  const ios = host ? { ...config.ios, associatedDomains: [`applinks:${host}`, `webcredentials:${host}`] } : config.ios;
  const android = {
    ...config.android,
    ...(googleServicesFile ? { googleServicesFile } : {}),
    ...(host
      ? {
          intentFilters: [
            {
              action: 'VIEW',
              autoVerify: true,
              data: appLinks.paths.map((pathPrefix) => ({ scheme: 'https', host, pathPrefix })),
              category: ['BROWSABLE', 'DEFAULT'],
            },
          ],
        }
      : {}),
  };

  return {
    ...config,
    ios,
    android,
    extra: { ...config.extra, apiUrl, webUrl, ...(wsUrl ? { wsUrl } : {}), appEnv: env, eas: { ...config.extra.eas, projectId } },
  };
};
