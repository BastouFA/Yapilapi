import { createHmac } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { safeEqual } from '@yapilapi/security';
import { notFound } from '@yapilapi/shared';
import type { Queryable } from '@yapilapi/database';
import type { AppContext } from '../../lib/context.js';
import { getMediaRuntime } from '../media/runtime.js';
import { isSafeKey } from '../media/storage.js';
import { hasSellerAccess, productSeller } from './access.js';

interface TokenPayload {
  u: string; // user the link was issued to
  p: string; // product
  m: string; // media
  e: number; // expiry (unix seconds)
}

const signingKey = (ctx: AppContext): Buffer =>
  createHmac('sha256', ctx.config.dataEncryptionKey).update('commerce-download-v1').digest();

/** Short-lived, tamper-proof download link: `<payload>.<hmac>`; the entitlement is re-checked when it is redeemed. */
export function signDownloadToken(
  ctx: AppContext,
  p: Omit<TokenPayload, 'e'>,
  now = Date.now(),
): { token: string; expiresAt: Date } {
  const e = Math.floor(now / 1000) + ctx.config.DOWNLOAD_URL_TTL_SEC;
  const body = Buffer.from(JSON.stringify({ ...p, e } satisfies TokenPayload)).toString(
    'base64url',
  );
  const sig = createHmac('sha256', signingKey(ctx)).update(body).digest('base64url');
  return { token: `${body}.${sig}`, expiresAt: new Date(e * 1000) };
}

export function verifyDownloadToken(
  ctx: AppContext,
  token: string,
  now = Date.now(),
): TokenPayload | null {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = createHmac('sha256', signingKey(ctx)).update(body).digest('base64url');
  if (!safeEqual(expected, sig)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (
      typeof p.u !== 'string' ||
      typeof p.p !== 'string' ||
      typeof p.m !== 'string' ||
      typeof p.e !== 'number'
    )
      return null;
    if (p.e * 1000 < now) return null;
    return p;
  } catch {
    return null;
  }
}

/** A user may download a product's files if they hold a granted digital entitlement (paid, not refunded), or they are the seller. */
export async function canDownload(
  db: Queryable,
  userId: string,
  productId: string,
): Promise<boolean> {
  const { rows } = await db.query<{
    business_id: string | null;
    seller_user_id: string | null;
    kind: string;
    entitled: boolean;
  }>(
    `SELECT pd.business_id, pd.seller_user_id, pd.kind,
            EXISTS (SELECT 1 FROM order_entitlements en JOIN orders o ON o.id = en.order_id
                     WHERE en.user_id = $1 AND en.kind = 'digital' AND en.status = 'granted' AND en.ref_id = pd.id
                       AND o.status IN ('paid','fulfilled','completed','partially_refunded')) AS entitled
       FROM products pd WHERE pd.id = $2 AND pd.deleted_at IS NULL`,
    [userId, productId],
  );
  const p = rows[0];
  if (!p || p.kind !== 'digital') return false;
  if (p.entitled) return true;
  return hasSellerAccess(db, productSeller(p), userId, 'catalog', { allowInactive: true });
}

/** Stream (local storage) or redirect (S3 presigned) one product file after the token and the entitlement check. */
export async function serveDownload(
  ctx: AppContext,
  token: string,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const p = verifyDownloadToken(ctx, token);
  if (!p) throw notFound('Download');
  const { rows } = await ctx.db.query<{
    storage_key: string;
    mime_type: string;
    size_bytes: number;
  }>(
    `SELECT m.storage_key, m.mime_type, m.size_bytes FROM product_files pf JOIN media m ON m.id = pf.media_id
      WHERE pf.product_id = $1 AND pf.media_id = $2 AND m.deleted_at IS NULL AND m.status IN ('uploaded','processing','ready')`,
    [p.p, p.m],
  );
  const m = rows[0];
  if (!m || !isSafeKey(m.storage_key) || !(await canDownload(ctx.db, p.u, p.p)))
    throw notFound('Download');
  const rt = getMediaRuntime(ctx);
  const disposition = `attachment; filename="yapilapi-download-${p.m.slice(0, 8)}.${m.storage_key.split('.').pop()}"`;
  void reply.headers({
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'content-disposition': disposition,
    'cache-control': 'private, no-store',
    'referrer-policy': 'no-referrer',
  });
  if (rt.adapter.presignGet) {
    const url = await rt.adapter.presignGet(m.storage_key, {
      expiresInSec: 120,
      contentType: m.mime_type,
      disposition,
    });
    return reply.redirect(url, 302);
  }
  const st = await rt.adapter.stat(m.storage_key);
  if (!st) throw notFound('Download');
  void req;
  void reply.headers({ 'content-type': m.mime_type, 'content-length': String(st.size) });
  return reply.send(await rt.adapter.read(m.storage_key));
}
