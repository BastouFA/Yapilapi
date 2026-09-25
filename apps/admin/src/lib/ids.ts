const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical UUID. Route params are validated before they reach a view or an API path. */
export const isUuid = (v: string | null | undefined): v is string =>
  typeof v === 'string' && UUID.test(v);
