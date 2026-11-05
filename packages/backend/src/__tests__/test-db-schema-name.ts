/** PostgreSQL identifier fragments shared by test worker creation and cleanup. */
export function sanitizeSchemaPart(value: string, maxLen = 32): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return (sanitized || "x").slice(0, maxLen);
}

export function vitestSchemaScopePrefix(scope?: string): string {
  return scope?.trim() ? `${sanitizeSchemaPart(scope.trim(), 12)}_` : "";
}

export function buildVitestRunSchemaPrefix(runId: string, scope?: string): string {
  return `vitest_${vitestSchemaScopePrefix(scope)}${sanitizeSchemaPart(runId, 20)}_`;
}

export function buildVitestSchemaName(runId: string, workerId: string, scope?: string): string {
  return `${buildVitestRunSchemaPrefix(runId, scope)}${sanitizeSchemaPart(workerId, 20)}`;
}
