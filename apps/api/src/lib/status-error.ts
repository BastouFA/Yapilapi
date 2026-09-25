import { AppError, type ErrorCode } from '@yapilapi/shared';

/**
 * An AppError with an explicit HTTP status, for the few honest answers the standard code table cannot express
 * (501 "this deployment has no provider configured", 503 "the tool needed is not installed"). The error handler only reads `.status`.
 */
export class StatusError extends AppError {
  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(code, message, details);
    Object.defineProperty(this, 'status', { value: status, enumerable: true });
  }
}

/** 501 feature_disabled: the capability exists in the API but no provider is configured in this deployment. */
export const notImplementedHere = (message: string, details?: unknown) =>
  new StatusError(501, 'feature_disabled', message, details);
