import type { ApiModule } from './types.js';
import { healthModule } from './health/index.js';
import { authModule } from './auth/index.js';
import { profilesModule } from './profiles/index.js';
import { graphModule } from './graph/index.js';
import { contentModule } from './content/index.js';
import { feedModule } from './feed/index.js';
import { messagingModule } from './messaging/index.js';
import { communitiesModule } from './communities/index.js';
import { mediaModule } from './media/index.js';
import { momentsModule } from './moments/index.js';
import { searchModule } from './search/index.js';
import { discoverModule } from './discover/index.js';
import { eventsModule } from './events/index.js';
import { placesModule } from './places/index.js';
import { businessModule } from './business/index.js';
import { safetyModule } from './safety/index.js';
import { privacyModule } from './privacy/index.js';
import { developerModule } from './developer/index.js';
import { notificationsModule } from './notifications/index.js';
import { adminModule } from './admin/index.js';
import { analyticsModule } from './analytics/index.js';
import { commerceModule } from './commerce/index.js';
import { paymentsModule } from './payments/index.js';
import { aiModule } from './ai/index.js';
import { creatorModule } from './creator/index.js';
import { studioModule } from './studio/index.js';
import { liveModule } from './live/index.js';
import { adsModule } from './ads/index.js';
import { realModule } from './real/index.js';
import { togetherModule } from './together/index.js';
import { memoryModule } from './memory/index.js';

/**
 * Registered API modules, in order. Each module owns its routes, SQL and business rules and
 * receives an explicit AppContext (no globals).
 */
export const modules: ApiModule[] = [
  healthModule,
  authModule,
  profilesModule,
  graphModule,
  contentModule,
  feedModule,
  communitiesModule,
  messagingModule,
  mediaModule,
  momentsModule,
  searchModule,
  discoverModule,
  eventsModule,
  placesModule,
  businessModule,
  safetyModule,
  commerceModule,
  paymentsModule,
  privacyModule,
  developerModule,
  notificationsModule,
  adminModule,
  analyticsModule,
  aiModule,
  creatorModule,
  studioModule,
  liveModule,
  adsModule,
  realModule,
  togetherModule,
  memoryModule,
];
