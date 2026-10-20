/**
 * Command executor — applies confirmed commands and records audit results.
 */

import type {
  CommandExecutionResult,
  CommandStepResult,
  IntegrationProvider,
} from "@opensprint/shared";
import { commandStore } from "./command-store.service.js";
import { intakeStore } from "./intake-store.service.js";
import { integrationStore } from "./integration-store.service.js";
import { intakeIngestion } from "./intake-ingestion.service.js";
import { taskStore } from "./task-store.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("command-executor");

export class CommandExecutorService {
  async execute(
    projectId: string,
    commandRunId: string,
    idempotencyKey?: string
  ): Promise<CommandExecutionResult> {
    const run = await commandStore.getRun(commandRunId, projectId);
    if (!run) {
      return {
        success: false,
        steps: [],
        summary: "Command run not found",
        error: `No command run with id ${commandRunId}`,
      };
    }

    if (idempotencyKey) {
      const existing = await commandStore.findByIdempotencyKey(
        idempotencyKey,
        projectId,
        commandRunId
      );
      if (existing?.result) {
        log.info("Returning cached result for idempotency key", { idempotencyKey });
        return existing.result;
      }
    }

    if (!run.interpreted_command) {
      return {
        success: false,
        steps: [],
        summary: "No interpreted command to execute",
        error: "Command was not interpreted",
      };
    }

    await commandStore.updateStatus(commandRunId, "executing");

    const steps: CommandStepResult[] = [];
    let success = true;
    let summary = "";

    try {
      const intent = run.interpreted_command;

      switch (intent.commandType) {
        case "list_intake": {
          const result = await intakeStore.listItems(run.project_id, {
            provider: intent.args.provider as IntegrationProvider | undefined,
            triageStatus: intent.args.triageStatus as
              | "new"
              | "triaged"
              | "converted"
              | "ignored"
              | undefined,
            search: intent.args.search,
            limit: intent.args.limit ?? 25,
          });
          steps.push({
            step: 1,
            description: `Found ${result.total} intake items`,
            success: true,
          });
          summary = `Listed ${result.items.length} of ${result.total} intake items`;
          break;
        }

        case "convert_intake": {
          let converted = 0;
          for (const [idx, itemId] of intent.args.itemIds.entries()) {
            try {
              const item = await intakeStore.updateTriageStatusForProject(
                run.project_id,
                itemId,
                "converted"
              );
              if (!item) throw new Error(`Intake item ${itemId} not found`);
              steps.push({
                step: idx + 1,
                description: `Converted intake item ${itemId}`,
                success: true,
                entityId: itemId,
              });
              converted++;
            } catch (err) {
              steps.push({
                step: idx + 1,
                description: `Failed to convert ${itemId}`,
                success: false,
                error: String(err),
              });
              success = false;
            }
          }
          summary = `Converted ${converted}/${intent.args.itemIds.length} intake items`;
          break;
        }

        case "start_execute": {
          steps.push({
            step: 1,
            description:
              "Execute command triggers orchestrator — task execution will start on next loop",
            success: true,
          });
          summary = "Execution triggered for unblocked tasks";
          break;
        }

        case "pause_integration": {
          const provider = intent.args.provider as IntegrationProvider;
          const conn = await integrationStore.getConnection(run.project_id, provider);
          if (!conn) {
            steps.push({
              step: 1,
              description: `No ${provider} connection found`,
              success: false,
              error: "Not connected",
            });
            success = false;
            summary = `Cannot pause ${provider}: not connected`;
          } else {
            await integrationStore.updateConnectionStatus(conn.id, "disabled");
            steps.push({
              step: 1,
              description: `Paused ${provider} integration`,
              success: true,
              entityId: conn.id,
            });
            summary = `Paused ${provider} integration`;
          }
          break;
        }

        case "resume_integration": {
          const provider = intent.args.provider as IntegrationProvider;
          const conn = await integrationStore.getConnection(run.project_id, provider);
          if (!conn) {
            steps.push({
              step: 1,
              description: `No ${provider} connection found`,
              success: false,
              error: "Not connected",
            });
            success = false;
            summary = `Cannot resume ${provider}: not connected`;
          } else {
            await integrationStore.updateConnectionStatus(conn.id, "active");
            steps.push({
              step: 1,
              description: `Resumed ${provider} integration`,
              success: true,
              entityId: conn.id,
            });
            summary = `Resumed ${provider} integration`;
          }
          break;
        }

        case "list_tasks": {
          const allTasks = await taskStore.listAll(run.project_id);
          const filtered = intent.args.status
            ? allTasks.filter((t) => t.status === intent.args.status)
            : allTasks;
          steps.push({ step: 1, description: `Found ${filtered.length} tasks`, success: true });
          summary = `Listed ${filtered.length} tasks`;
          break;
        }

        case "create_task": {
          const task = await taskStore.create(run.project_id, intent.args.title, {
            description: intent.args.description,
          });
          steps.push({
            step: 1,
            description: `Created task: ${task.id}`,
            success: true,
            entityId: task.id,
          });
          summary = `Created task "${intent.args.title}"`;
          break;
        }

        case "sync_integration": {
          const provider = intent.args.provider as IntegrationProvider;
          const conn = await integrationStore.getConnection(run.project_id, provider);
          if (!conn) {
            steps.push({
              step: 1,
              description: `No ${provider} connection found`,
              success: false,
              error: "Not connected",
            });
            success = false;
            summary = `Cannot sync ${provider}: not connected`;
          } else {
            const result = await intakeIngestion.ingestFromConnection(conn.id);
            steps.push({
              step: 1,
              description: `Synced ${provider}: ${result.imported} imported, ${result.errors} errors`,
              success: result.errors === 0,
              entityId: conn.id,
            });
            summary = `Synced ${provider}: ${result.imported} imported`;
            if (result.errors > 0) success = false;
          }
          break;
        }

        case "show_project_status": {
          const tasks = await taskStore.listAll(run.project_id);
          const open = tasks.filter((t) => t.status === "open").length;
          const blocked = tasks.filter((t) => t.status === "blocked").length;
          const closed = tasks.filter((t) => t.status === "closed").length;
          steps.push({
            step: 1,
            description: `Project has ${tasks.length} tasks: ${open} open, ${blocked} blocked, ${closed} closed`,
            success: true,
          });
          summary = `${tasks.length} total tasks (${open} open, ${blocked} blocked, ${closed} closed)`;
          break;
        }

        case "unrecognized": {
          success = false;
          summary = "Command not recognized";
          steps.push({
            step: 1,
            description: intent.args.suggestion ?? "Try a different command",
            success: false,
            error: "Unrecognized command",
          });
          break;
        }
      }
    } catch (err) {
      success = false;
      const errMsg = err instanceof Error ? err.message : String(err);
      summary = `Command execution failed: ${errMsg}`;
      log.error("Command execution failed", { commandRunId, error: errMsg });
    }

    const result: CommandExecutionResult = { success, steps, summary };
    await commandStore.updateResult(commandRunId, result, idempotencyKey);
    return result;
  }
}

export const commandExecutor = new CommandExecutorService();
