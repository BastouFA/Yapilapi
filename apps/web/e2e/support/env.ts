/** Ports and names used by the end-to-end run. Test-only: a private database, never the dev one. */
export const API_PORT = Number(process.env['E2E_API_PORT'] ?? 4317);
export const WEB_PORT = Number(process.env['E2E_WEB_PORT'] ?? 3317);
export const API_URL = `http://127.0.0.1:${API_PORT}`;
export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
export const DB_NAME = 'yapilapi_test_web';
export const DB_URL = `postgres://yapilapi:yapilapi_dev_password@127.0.0.1:5432/${DB_NAME}`;
export const ADMIN_DB_URL = 'postgres://yapilapi:yapilapi_dev_password@127.0.0.1:5432/postgres';
export const API_LOG = '/tmp/yapilapi-e2e-api.log';
