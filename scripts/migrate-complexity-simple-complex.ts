#!/usr/bin/env npx tsx
/**
 * One-time migration script: map legacy task/epic complexity data.
 * - "simple" → 3
 * - "complex" → 7
 *
 * Migrates tasks (including epics) where extra JSON contains
 * complexity: "simple" or complexity: "complex".
 *
 * Idempotent and safe to run multiple times.
 *
 * Usage: npx tsx scripts/migrate-complexity-simple-complex.ts
 */

import { migrateComplexitySimpleToComplex } from "../packages/backend/src/services/migrate-complexity-simple-complex.js";

async function main(): Promise<void> {
  const { migratedCount, details } = await migrateComplexitySimpleToComplex();

  if (migratedCount === 0) {
    console.log("No tasks with legacy complexity (simple/complex) found.");
    return;
  }

  console.log(`Migrated ${migratedCount} task(s):`);
  for (const d of details) {
    console.log(`  - ${d.id} (project: ${d.projectId}): "${d.from}" → ${d.to}`);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
