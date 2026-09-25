import type { ApiModule } from '../types.js';
import { registerAdminUserRoutes } from './users.js';
import { registerAdminEntityRoutes } from './entities.js';
import { registerAdminOpsRoutes } from './ops.js';
import { registerFlagRoutes } from './flags.js';

export * from './rbac.js';
export { maskEmail } from './users.js';

/**
 * Staff console API. Authorization is a single permission matrix (rbac.ts); every route declares the permission it needs
 * with `adminRoute`, the route helper enforces staff role + MFA, and every action that changes state is audited.
 * Actions that other modules already own (business verification, payouts, refunds, order review, media blocking, place
 * claims) stay in those modules under /v1/staff/* and /v1/admin/media/*; this module adds read overviews next to them.
 */
export const adminModule: ApiModule = {
  name: 'admin',
  register(app, ctx) {
    registerAdminUserRoutes(app, ctx);
    registerAdminEntityRoutes(app, ctx);
    registerAdminOpsRoutes(app, ctx);
    registerFlagRoutes(app, ctx);
  },
};
