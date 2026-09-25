import type { ZodType, ZodTypeDef } from 'zod';

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Log in to continue.') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = "You don't have permission to do that.") => new AppError(403, 'forbidden', message);
export const notFound = (what = 'That item') => new AppError(404, 'not_found', `${what} doesn't exist or isn't visible to you.`);
export const conflict = (message: string) => new AppError(409, 'conflict', message);
export const featureDisabled = (flag: string) => new AppError(404, 'feature_disabled', `${flag} is not enabled.`);

/** Validate input against a zod schema, throwing a 400 with field errors. */
export function parse<Out, In = Out>(schema: ZodType<Out, ZodTypeDef, In>, data: unknown): Out {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const issue of r.error.issues) fields[issue.path.join('.') || '_'] ??= issue.message;
    throw new AppError(400, 'validation_failed', 'Check the highlighted fields.', { fields });
  }
  return r.data;
}
