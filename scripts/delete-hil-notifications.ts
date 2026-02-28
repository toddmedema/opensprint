#!/usr/bin/env npx tsx
/**
 * Manual utility: delete all HIL (Human In the Loop) notifications from storage.
 * Use for testing, cleanup, or when you need to clear all notifications.
 *
 * Idempotent and safe to run multiple times.
 *
 * Usage: npx tsx scripts/delete-hil-notifications.ts
 *        npm run delete-hil-notifications
 */

import { taskStore } from "../packages/backend/src/services/task-store.service.js";
import { notificationService } from "../packages/backend/src/services/notification.service.js";

async function main(): Promise<void> {
  await taskStore.init();

  const deletedCount = await notificationService.deleteAll();

  if (deletedCount === 0) {
    console.log("No HIL notifications found.");
    return;
  }

  console.log(`Deleted ${deletedCount} HIL notification(s).`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
