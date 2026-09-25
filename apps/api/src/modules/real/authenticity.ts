/**
 * Authenticity receipts for Real captures. Everything here is PURE (unit tested) and honest about what it can know.
 *
 * What the server CAN verify: the capture was requested through a signed in-app session for this user and device, the upload followed within
 * the capture window, the media files were created after that session started (so they are not old gallery files), each file is used once,
 * and no edit operation is known to the server.
 * What it CANNOT verify: that the pixels came from a physical camera. That needs Apple App Attest / Play Integrity; until an
 * AttestationVerifier that does so is configured, `device_attested` is false and no indicator claims otherwise.
 */

export const CLOCK_TOLERANCE_MS = 2 * 60_000;
/** Longest gap between the (skew-corrected) capture time and the server receiving it. Equal to the capture token lifetime. */
export const MAX_UPLOAD_DELAY_MS = 10 * 60_000;

export interface AttestationInput {
  userId: string;
  deviceId: string;
  payload?: string | undefined;
}
export interface AttestationResult {
  attested: boolean;
  provider: string;
}
/** Plug-in point for platform attestation. The only implementation shipped is `none`. */
export interface AttestationVerifier {
  readonly provider: string;
  verify(input: AttestationInput): Promise<AttestationResult>;
}
export const noneAttestationVerifier: AttestationVerifier = {
  provider: 'none',
  verify: async () => ({ attested: false, provider: 'none' }),
};

export interface AuthenticityInput {
  /** Client-claimed capture time (epoch ms). */
  capturedAtMs: number;
  /** When the server received the capture (epoch ms). */
  receivedAtMs: number;
  /** When the capture session (token) was issued (epoch ms). */
  sessionIssuedAtMs: number;
  /** Server minus client clock at session issue; null when the client did not send its clock. */
  clockSkewMs: number | null;
  /** created_at (epoch ms) of each media file of the capture. */
  mediaCreatedAtMs: number[];
  /** Edit operations the CLIENT declares (crop, filter, ...). Unverifiable, but declaring one flips `edited`. */
  declaredEdits: string[];
  /** Edit operations the server itself performed on the media (none exist for Real today). */
  serverEditOps: string[];
  attested: boolean;
  tokenVerified: boolean;
}

export interface Authenticity {
  capture_window_ok: boolean;
  /** Estimated device clock offset (server minus client) in ms; null when unknown. */
  clock_skew_ms: number | null;
  edited: boolean;
  device_attested: boolean;
  method: 'in_app_token' | 'none';
  /** Coarse summary: 'attested' only with hardware attestation; 'in_app' when every server check passed; else 'unverified'. */
  assurance: 'attested' | 'in_app' | 'unverified';
  checks: {
    token_verified: boolean;
    window_after_session_start: boolean;
    within_upload_delay: boolean;
    not_in_future: boolean;
    media_fresh: boolean;
  };
  declared_edits: string[];
}

export function computeAuthenticity(i: AuthenticityInput): Authenticity {
  const effective = i.capturedAtMs + (i.clockSkewMs ?? 0); // capture time on the SERVER's clock
  const windowAfterStart = effective >= i.sessionIssuedAtMs - CLOCK_TOLERANCE_MS;
  const notFuture = effective <= i.receivedAtMs + CLOCK_TOLERANCE_MS;
  const delayOk = i.receivedAtMs - effective <= MAX_UPLOAD_DELAY_MS;
  const mediaFresh =
    i.mediaCreatedAtMs.length > 0 &&
    i.mediaCreatedAtMs.every(
      (m) =>
        m >= i.sessionIssuedAtMs - CLOCK_TOLERANCE_MS && m <= i.receivedAtMs + CLOCK_TOLERANCE_MS,
    );
  const windowOk = i.tokenVerified && windowAfterStart && notFuture && delayOk;
  const edited = i.declaredEdits.length > 0 || i.serverEditOps.length > 0;
  const assurance: Authenticity['assurance'] =
    i.attested && windowOk && mediaFresh
      ? 'attested'
      : windowOk && mediaFresh && i.tokenVerified
        ? 'in_app'
        : 'unverified';
  return {
    capture_window_ok: windowOk,
    clock_skew_ms: i.clockSkewMs,
    edited,
    device_attested: i.attested,
    method: i.tokenVerified ? 'in_app_token' : 'none',
    assurance,
    checks: {
      token_verified: i.tokenVerified,
      window_after_session_start: windowAfterStart,
      within_upload_delay: delayOk,
      not_in_future: notFuture,
      media_fresh: mediaFresh,
    },
    declared_edits: [...i.declaredEdits],
  };
}

export interface Indicator {
  key: string;
  ok: boolean;
  label: string;
}

/** User-facing indicators. Labels state what was checked, never more ("taken in the app", not "genuine"). */
export function authenticityIndicators(a: Partial<Authenticity> | null | undefined): Indicator[] {
  const x = a ?? {};
  return [
    {
      key: 'captured_in_app',
      ok: x.method === 'in_app_token',
      label:
        x.method === 'in_app_token'
          ? 'Captured with the YAPILAPI camera session'
          : 'Not captured through a verified session',
    },
    {
      key: 'capture_window',
      ok: x.capture_window_ok === true,
      label: x.capture_window_ok
        ? 'Uploaded right after it was taken'
        : 'Capture time could not be verified',
    },
    {
      key: 'unedited',
      ok: x.edited === false,
      label: x.edited === false ? 'No edits declared or detected' : 'Edited after capture',
    },
    {
      key: 'device_attested',
      ok: x.device_attested === true,
      label: x.device_attested
        ? 'Device attested by the platform'
        : 'Device not attested (not checked)',
    },
  ];
}
