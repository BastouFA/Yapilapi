// Build-time settings on top of app.json. Local development uses app.json as it is. EAS builds
// read these environment variables from the EAS environment named in eas.json ("development",
// "preview" or "production"); none of them is a secret. See docs/operations/app-store.md.
//
//   YAPILAPI_API_URL  the API the app talks to, e.g. https://api.example.com
//   YAPILAPI_WEB_URL  the web app, for shared links and the legal pages, e.g. https://example.com
//   EAS_PROJECT_ID    from `eas init` (push notifications need it)
//   YAPILAPI_APP_ENV  development, preview or production (set by eas.json)
module.exports = ({ config }) => {
  const env = process.env.YAPILAPI_APP_ENV ?? 'development';
  const apiUrl = process.env.YAPILAPI_API_URL || config.extra.apiUrl;
  const webUrl = process.env.YAPILAPI_WEB_URL || config.extra.webUrl;
  const projectId = process.env.EAS_PROJECT_ID || config.extra.eas.projectId;

  // A store build must never point at a development machine, or ship without push.
  if (env === 'production') {
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|10\.|192\.168\.)/;
    if (local.test(apiUrl) || local.test(webUrl) || !/^https:/.test(apiUrl) || !/^https:/.test(webUrl))
      throw new Error('Production builds need YAPILAPI_API_URL and YAPILAPI_WEB_URL set to https addresses (eas env:create --environment production).');
    if (!projectId) throw new Error('Production builds need EAS_PROJECT_ID (run `eas init` and set it in the production environment).');
  }

  return {
    ...config,
    extra: { ...config.extra, apiUrl, webUrl, appEnv: env, eas: { ...config.extra.eas, projectId } },
  };
};
