import { z } from 'zod';
import { emailSchema, passwordSchema, usernameSchema } from '@yapilapi/shared';

export const deliverSchema = z.enum(['cookie', 'token']).default('cookie');

export const registerBody = z.object({
  email: emailSchema,
  password: passwordSchema,
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(60),
  birthDate: z.iso.date(),
  locale: z.string().min(2).max(10).default('en'),
  timezone: z.string().min(1).max(64).default('UTC'),
  deliver: deliverSchema,
  acceptTerms: z.literal(true),
});

export const loginBody = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
  deliver: deliverSchema,
  deviceLabel: z.string().max(80).optional(),
});

export const mfaVerifyBody = z
  .object({
    challengeToken: z.string().min(10).max(200),
    code: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    recoveryCode: z.string().min(5).max(30).optional(),
    deliver: deliverSchema,
  })
  .refine(
    (b) => Boolean(b.code) !== Boolean(b.recoveryCode),
    'Provide either code or recoveryCode',
  );

export const tokenBody = z.object({ token: z.string().min(10).max(200) });
export const forgotBody = z.object({ email: emailSchema });
export const resetBody = z.object({
  token: z.string().min(10).max(200),
  newPassword: passwordSchema,
});
export const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});
export const mfaEnableBody = z.object({ code: z.string().regex(/^\d{6}$/) });
export const mfaDisableBody = z.object({
  password: z.string().min(1).max(200),
  code: z.string().regex(/^\d{6}$/),
});
export const deleteAccountBody = z.object({ password: z.string().min(1).max(200) });
export const idParams = z.object({ id: z.uuid() });
