/**
 * Convert SQLite-style ? placeholders to Postgres $1, $2, ... placeholders.
 */
export function toPgParams(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}
