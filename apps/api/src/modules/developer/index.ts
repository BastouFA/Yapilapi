import type { ApiModule } from '../types.js';
import { registerAppRoutes } from './apps.js';
import { registerOAuthRoutes } from './oauth-routes.js';
import { registerPublicApi } from './public-api.js';
import { registerMiniAppRoutes } from './miniapps.js';

export * from './oauth.js';
export * from './webhooks.js';
export {
  validateWebhookUrl,
  isBlockedIp,
  resolvePublicAddress,
  setWebhookNetwork,
  WebhookUrlError,
} from './ssrf.js';
export { API_KEY_SCOPES } from './apps.js';
export { MINI_APP_PERMISSIONS } from './miniapps.js';

export const developerModule: ApiModule = {
  name: 'developer',
  register(app, ctx) {
    registerAppRoutes(app, ctx);
    registerOAuthRoutes(app, ctx);
    registerPublicApi(app, ctx);
    registerMiniAppRoutes(app, ctx);
  },
};
