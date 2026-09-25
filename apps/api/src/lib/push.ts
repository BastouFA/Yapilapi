/**
 * Push delivery adapters. `PushSender` is the seam: notify() hands a small, content-free payload to it.
 *  - LogPushSender:    development default, logs and reports success.
 *  - MemoryPushSender: tests capture what would have been sent.
 *  - ExpoPushSender:   Expo push service over HTTPS (https://exp.host/--/api/v2/push/send). It CANNOT be exercised
 *                      in CI (it needs a real device token and network access to Expo), so it is isolated here and
 *                      covered only by unit tests of the request shape / response handling. Verify on a real device
 *                      before relying on it (see docs/security/privacy.md "Push").
 * Payloads never contain message text or other private content: lock screens are public surfaces.
 */

export interface PushMessage {
  token: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

export interface PushResult {
  token: string;
  ok: boolean;
  /** Token is permanently invalid (uninstalled app, revoked permission): the caller should disable it. */
  invalidToken?: boolean;
  error?: string;
}

export interface PushSender {
  send(messages: PushMessage[]): Promise<PushResult[]>;
}

export class LogPushSender implements PushSender {
  constructor(private readonly log: (line: string) => void) {}
  async send(messages: PushMessage[]): Promise<PushResult[]> {
    for (const m of messages)
      this.log(`[dev-push] token=${m.token.slice(0, 12)}... title="${m.title}" body="${m.body}"`);
    return messages.map((m) => ({ token: m.token, ok: true }));
  }
}

export class MemoryPushSender implements PushSender {
  readonly sent: PushMessage[] = [];
  /** Tokens that should be reported as permanently invalid. */
  invalid = new Set<string>();
  async send(messages: PushMessage[]): Promise<PushResult[]> {
    return messages.map((m) => {
      if (this.invalid.has(m.token))
        return { token: m.token, ok: false, invalidToken: true, error: 'DeviceNotRegistered' };
      this.sent.push(m);
      return { token: m.token, ok: true };
    });
  }
}

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export class ExpoPushSender implements PushSender {
  constructor(
    private readonly accessToken?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Build the request body (exported for unit tests). Expo accepts at most 100 messages per request. */
  static toRequest(messages: PushMessage[]) {
    return messages.map((m) => ({
      to: m.token,
      title: m.title,
      body: m.body,
      data: m.data,
      sound: 'default',
      priority: 'high',
    }));
  }

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    const results: PushResult[] = [];
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      try {
        const res = await this.fetchImpl(EXPO_PUSH_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
          },
          body: JSON.stringify(ExpoPushSender.toRequest(chunk)),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          for (const m of chunk)
            results.push({ token: m.token, ok: false, error: `http_${res.status}` });
          continue;
        }
        const json = (await res.json()) as {
          data?: Array<{ status: string; message?: string; details?: { error?: string } }>;
        };
        chunk.forEach((m, idx) => {
          const t = json.data?.[idx];
          if (t?.status === 'ok') results.push({ token: m.token, ok: true });
          else
            results.push({
              token: m.token,
              ok: false,
              invalidToken: t?.details?.error === 'DeviceNotRegistered',
              error: t?.details?.error ?? t?.message ?? 'unknown',
            });
        });
      } catch (err) {
        for (const m of chunk)
          results.push({ token: m.token, ok: false, error: (err as Error).name });
      }
    }
    return results;
  }
}
