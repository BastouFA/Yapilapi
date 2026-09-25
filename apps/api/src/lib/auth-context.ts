import type { PlatformRole } from '@yapilapi/shared';

export interface AuthContext {
  userId: string;
  sessionId: string;
  platformRole: PlatformRole;
  ageBand: 'teen' | 'adult';
  mfaVerified: boolean;
  emailVerified: boolean;
  via: 'cookie' | 'bearer';
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set lazily by the route helper for routes that declare auth. Never trust anything from the client here. */
    authContext?: AuthContext | null;
    /** Set at request start for rate limiting/audit. */
    clientIp: string;
  }
}
