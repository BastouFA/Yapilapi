/**
 * A row as the `pg` driver returns it: column names to whatever the column type parses to (Date, number, string, jsonb...).
 * Mappers that turn `SELECT *` / joined rows into API views read columns by name; the driver gives us no static column types,
 * so this is the one place where the untyped boundary is declared.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped pg driver boundary: column types are unknown to TypeScript
export type DbRow = Record<string, any>;
