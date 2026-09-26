import { createHash, createHmac } from 'node:crypto';

/**
 * Minimal AWS Signature Version 4 for JSON API calls (Rekognition). The AWS SDK
 * would bring in a large dependency for one request; this follows
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html.
 */
export interface SigV4Input {
  method: string;
  url: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Injectable clock for tests. */
  now?: Date;
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding, as SigV4 requires (encodeURIComponent leaves !'()* alone). */
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function signingKey(secretAccessKey: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request');
}

/** Returns the headers to send: the ones given plus host, x-amz-date, the session token and authorization. */
export function signV4(input: SigV4Input): Record<string, string> {
  const url = new URL(input.url);
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...input.headers, host: url.host, 'x-amz-date': amzDate };
  if (input.sessionToken) headers['x-amz-security-token'] = input.sessionToken;

  const lower = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalHeaders = lower.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = lower.map(([k]) => k).join(';');
  const canonicalUri = url.pathname.split('/').map(rfc3986).join('/') || '/';
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [input.method.toUpperCase(), canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, sha256(input.body ?? '')].join('\n');
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(input.secretAccessKey, date, input.region, input.service))
    .update(stringToSign)
    .digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
