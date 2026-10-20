/**
 * Command preview/validation service — generates dry-run previews
 * showing what mutations a command would perform.
 */

import type { CommandPreview, CommandMutation, CommandInterpretation } from "@opensprint/shared";
import { intakeStore } from "./intake-store.service.js";
import { taskStore } from "./task-store.service.js";
import { integrationStore } from "./integration-store.service.js";
import type { IntegrationProvider } from "@opensprint/shared";

export class CommandPreviewService {
  async generatePreview(
    projectId: string,
    interpretation: CommandInterpretation
  ): Promise<CommandPreview> {
    const { intent } = interpretation;
    const mutations: CommandMutation[] = [];
    const warnings: string[] = [];
    let description = "";

    switch (intent.commandType) {
      case "list_intake": {
        description =
          "List intake items" +
          (intent.args.provider ? ` from ${intent.args.provider}` : "") +
          (intent.args.triageStatus ? ` with status ${intent.args.triageStatus}` : "");
        break;
      }

      case "convert_intake": {
        const items = intent.args.itemIds;
        for (const itemId of items) {
          const item = await intakeStore.getItemForProject(projectId, itemId);
          if (!item) {
            warnings.push(`Intake item ${itemId} not found`);
            continue;
          }
          mutations.push({
            entityType: "intake_item",
            entityId: itemId,
            operation: "update",
            summary: `Convert "${item.title}" → ${intent.args.action}`,
          });
        }
        description = `Convert ${items.length} intake item(s) to ${intent.args.action}`;
        break;
      }

      case "start_execute": {
        const tasks = await taskStore.ready(projectId);
        const filtered = intent.args.epicId
          ? tasks.filter((t) => (t as Record<string, unknown>).epicId === intent.args.epicId)
          : tasks;
        for (const task of filtered.slice(0, 10)) {
          mutations.push({
            entityType: "task",
            entityId: task.id,
            operation: "update",
            summary: `Start execution: "${task.title}"`,
          });
        }
        if (filtered.length > 10) {
          warnings.push(`Showing first 10 of ${filtered.length} tasks`);
        }
        description = `Start execution on ${filtered.length} unblocked task(s)`;
        if (filtered.length === 0) warnings.push("No unblocked tasks found");
        break;
      }

      case "pause_integration": {
        const provider = intent.args.provider as IntegrationProvider;
        const conn = await integrationStore.getConnection(projectId, provider);
        if (!conn) {
          warnings.push(`No ${provider} integration connected`);
        } else {
          mutations.push({
            entityType: "integration_connection",
            entityId: conn.id,
            operation: "update",
            summary: `Pause ${provider} integration sync`,
          });
        }
        description = `Pause ${provider} integration`;
        break;
      }

      case "resume_integration": {
        const provider = intent.args.provider as IntegrationProvider;
        const conn = await integrationStore.getConnection(projectId, provider);
        if (!conn) {
          warnings.push(`No ${provider} integration connected`);
        } else {
          mutations.push({
            entityType: "integration_connection",
            entityId: conn.id,
            operation: "update",
            summary: `Resume ${provider} integration sync`,
          });
        }
        description = `Resume ${provider} integration`;
        break;
      }

      case "list_tasks": {
        description =
          "List tasks" +
          (intent.args.status ? ` with status ${intent.args.status}` : "") +
          (intent.args.epicId ? ` in epic ${intent.args.epicId}` : "");
        break;
      }

      case "create_task": {
        mutations.push({
          entityType: "task",
          operation: "create",
          summary: `Create task: "${intent.args.title}"`,
        });
        description = `Create a new task: "${intent.args.title}"`;
        break;
      }

      case "sync_integration": {
        const provider = intent.args.provider as IntegrationProvider;
        const conn = await integrationStore.getConnection(projectId, provider);
        if (!conn) {
          warnings.push(`No ${provider} integration connected`);
        }
        description = `Trigger sync for ${provider} integration`;
        break;
      }

      case "show_project_status": {
        description = "Show current project status";
        break;
      }

      case "unrecognized": {
        description = "Unrecognized command";
        warnings.push(intent.args.suggestion ?? "Try a different command");
        break;
      }
    }

    return {
      interpretation,
      mutations,
      warnings,
      description,
    };
  }
}

export const commandPreview = new CommandPreviewService();
