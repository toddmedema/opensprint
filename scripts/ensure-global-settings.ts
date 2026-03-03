#!/usr/bin/env npx tsx
/**
 * Ensures ~/.opensprint exists and global-settings.json has default databaseUrl if missing.
 * Used by setup.sh. Idempotent; safe to run multiple times.
 * Self-contained (no workspace imports) so it runs before npm run build.
 *
 * Usage: npx tsx scripts/ensure-global-settings.ts
 */

import fs from "fs/promises";
import path from "path";

const DEFAULT_DATABASE_URL = "postgresql://opensprint:opensprint@localhost:5432/opensprint";

function getGlobalSettingsPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return path.join(home, ".opensprint", "global-settings.json");
}

async function main(): Promise<void> {
  const file = getGlobalSettingsPath();
  const dir = path.dirname(file);

  await fs.mkdir(dir, { recursive: true });

  let settings: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    // File missing or corrupt; start fresh
  }

  if (!settings.databaseUrl || typeof settings.databaseUrl !== "string") {
    settings.databaseUrl = DEFAULT_DATABASE_URL;
    await fs.writeFile(file, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
