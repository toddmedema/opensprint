/**
 * Drizzle ORM schema for PostgreSQL.
 * Mirrors the tables in schema.ts. Used when dialect is postgres.
 */

import { pgTable, text, primaryKey, integer, boolean, serial } from "drizzle-orm/pg-core";

export const plansTable = pgTable(
  "plans",
  {
    projectId: text("project_id").notNull(),
    planId: text("plan_id").notNull(),
    epicId: text("epic_id").notNull(),
    gateTaskId: text("gate_task_id"),
    reExecuteGateTaskId: text("re_execute_gate_task_id"),
    content: text("content").notNull(),
    metadata: text("metadata").notNull(),
    shippedContent: text("shipped_content"),
    updatedAt: text("updated_at").notNull(),
    currentVersionNumber: integer("current_version_number").notNull().default(1),
    lastExecutedVersionNumber: integer("last_executed_version_number"),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.planId] })]
);

export const planVersionsTable = pgTable(
  "plan_versions",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id").notNull(),
    planId: text("plan_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    title: text("title"),
    content: text("content").notNull(),
    metadata: text("metadata"),
    createdAt: text("created_at").notNull(),
    isExecutedVersion: boolean("is_executed_version").notNull().default(false),
  },
  (t) => []
);
