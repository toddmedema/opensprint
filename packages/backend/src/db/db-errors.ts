/** Node.js/network codes: Postgres server unreachable */
const DB_UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

/** PostgreSQL error codes: server reachable but auth/database/config wrong */
const DB_AUTH_CONFIG_CODES = new Set([
  "28P01", // invalid_password
  "28000", // invalid_authorization_specification
  "3D000", // invalid_catalog_name (database does not exist)
  "42501", // insufficient_privilege
  "42P01", // undefined_table (schema not applied)
]);

function getErrorCode(err: unknown): string {
  const code =
    (err as NodeJS.ErrnoException).code ??
    (err as { code?: string }).code ??
    (err as { errno?: number }).errno;
  return typeof code === "number" ? String(code) : String(code ?? "");
}

export function isDbConnectionError(err: unknown): boolean {
  const code = getErrorCode(err);
  if (DB_UNREACHABLE_CODES.has(code) || DB_AUTH_CONFIG_CODES.has(code)) {
    return true;
  }

  const msg = err instanceof Error ? err.message : String(err);
  return (
    /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|connection refused|getaddrinfo|connect EHOSTUNREACH|password authentication failed|role .* does not exist|database .* does not exist|permission denied|relation .* does not exist/i.test(
      msg
    )
  );
}

export function classifyDbConnectionError(err: unknown): string {
  const code = getErrorCode(err);

  if (DB_UNREACHABLE_CODES.has(code)) {
    return "No PostgreSQL server running";
  }
  if (DB_AUTH_CONFIG_CODES.has(code)) {
    return "PostgreSQL server is running but wrong user or database setup";
  }

  const msg = err instanceof Error ? err.message : String(err);
  if (
    /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|connection refused|getaddrinfo|connect EHOSTUNREACH/i.test(
      msg
    )
  ) {
    return "No PostgreSQL server running";
  }
  if (
    /password authentication failed|role .* does not exist|database .* does not exist|permission denied|relation .* does not exist/i.test(
      msg
    )
  ) {
    return "PostgreSQL server is running but wrong user or database setup";
  }

  return "Server is unable to connect to PostgreSQL database.";
}
