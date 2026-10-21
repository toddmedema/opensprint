import type { DbClient } from "./client.js";

/** PostgreSQL transaction timestamps freeze at BEGIN; leases need the current database clock. */
export async function databaseNow(tx: DbClient): Promise<number> {
  const sql =
    tx.dialect === "postgres"
      ? "SELECT clock_timestamp() AS now"
      : tx.dialect === "sqlite"
        ? "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now"
        : "SELECT CURRENT_TIMESTAMP AS now";
  const row = await tx.queryOne(sql);
  const raw = row?.now;
  const stamp = String(raw).replace(" ", "T");
  const value =
    raw instanceof Date
      ? raw.getTime()
      : Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(stamp) ? stamp : `${stamp}Z`);
  if (!Number.isFinite(value)) throw new Error("Database did not return a valid clock.");
  return value;
}
