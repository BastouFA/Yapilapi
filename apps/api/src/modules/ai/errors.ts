import { AppError, forbidden, notFound } from '@yapilapi/shared';

/** Why the Permission Engine said no. Machine-readable; written to ai_tool_calls.denial_reason. */
export type DenialReason =
  | 'not_visible'
  | 'not_member'
  | 'consent_required'
  | 'not_attached'
  | 'teen_restricted'
  | 'assistant_disabled'
  | 'scope_mismatch'
  | 'tool_not_allowed'
  | 'feature_disabled'
  | 'permission_missing';

export class PermissionDenied extends Error {
  constructor(
    readonly reason: DenialReason,
    message?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message ?? reason);
    this.name = 'PermissionDenied';
  }
}

/** 503: every provider in the chain failed (or none is configured for the task). */
export class AiUnavailableError extends AppError {
  constructor(message = 'The AI service is temporarily unavailable. Please try again shortly.') {
    super('internal', message, { reason: 'ai_unavailable' });
    (this as { status: number }).status = 503;
  }
}

/** 501: a capability that needs an external provider nobody configured (speech). Never fakes a result. */
export class NotImplementedFeature extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('feature_disabled', message, { reason: 'provider_not_configured', ...details });
    (this as { status: number }).status = 501;
  }
}

/** Map a denial to the HTTP error the API would give for the same request made without AI (never reveal existence). */
export function denialToError(d: PermissionDenied): AppError {
  switch (d.reason) {
    case 'not_visible':
    case 'not_member':
    case 'assistant_disabled':
    case 'scope_mismatch':
      return notFound('Resource');
    case 'consent_required':
      return new AppError('forbidden', d.message || 'This needs your consent for AI processing', {
        reason: 'consent_required',
        ...d.detail,
      });
    case 'feature_disabled':
      return new AppError('feature_disabled', d.message);
    default:
      return forbidden(d.message || 'Not allowed');
  }
}
