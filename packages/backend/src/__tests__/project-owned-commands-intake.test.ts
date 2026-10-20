import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { initAppDb, type AppDb } from "../db/app-db.js";
import { taskStore } from "../services/task-store.service.js";
import { intakeStore } from "../services/intake-store.service.js";
import { commandStore } from "../services/command-store.service.js";
import { commandExecutor } from "../services/command-executor.service.js";
import { commandPreview } from "../services/command-preview.service.js";
import { createCommandsRouter } from "../routes/commands.js";
import { createIntakeRouter } from "../routes/intake.js";
import { errorHandler } from "../middleware/error-handler.js";

describe("project-scoped commands and intake with SQLite", () => {
  let db: AppDb;
  let app: ReturnType<typeof express>;
  let a: string;
  let b: string;
  beforeEach(async () => {
    db = await initAppDb("sqlite://:memory:");
    vi.spyOn(taskStore, "getDb").mockResolvedValue(await db.getClient());
    vi.spyOn(taskStore, "runWrite").mockImplementation((fn) => db.runWrite(fn));
    a = (
      await intakeStore.upsertItem({
        project_id: "A",
        provider: "todoist",
        external_item_id: "a",
        title: "A title",
      })
    ).item.id;
    b = (
      await intakeStore.upsertItem({
        project_id: "B",
        provider: "todoist",
        external_item_id: "b",
        title: "Private B title",
      })
    ).item.id;
    app = express();
    app.use(express.json());
    app.use("/projects/:projectId/commands", createCommandsRouter());
    app.use("/projects/:projectId/intake", createIntakeRouter());
    app.use(errorHandler);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });

  it("scopes intake reads/mutations and preserves partial bulk outcomes", async () => {
    for (const suffix of ["", "/convert", "/ignore"]) {
      const operation = suffix
        ? request(app).post(`/projects/A/intake/${b}${suffix}`).send({ action: "ignore" })
        : request(app).get(`/projects/A/intake/${b}`);
      expect((await operation).status).toBe(404);
    }
    expect((await request(app).get(`/projects/A/intake/${a}`)).body.data.title).toBe("A title");
    const preview = await request(app)
      .post("/projects/A/intake/bulk")
      .send({ itemIds: [a, b, "missing"], action: "ignore", dryRun: true });
    expect(preview.body.data).toMatchObject({ processed: 1, errors: 0 });
    expect(JSON.stringify(preview.body)).not.toContain("Private B title");
    const result = await request(app)
      .post("/projects/A/intake/bulk")
      .send({ itemIds: [a, b, "missing"], action: "ignore" });
    expect(result.body.data).toMatchObject({ processed: 1, errors: 2 });
    expect((await intakeStore.getItemForProject("A", a))?.triage_status).toBe("ignored");
    expect((await intakeStore.getItemForProject("B", b))?.triage_status).toBe("new");
    expect(
      (await request(app).post(`/projects/A/intake/${a}/convert`).send({ action: "to_task_draft" }))
        .status
    ).toBe(200);
    expect((await request(app).post(`/projects/A/intake/${a}/ignore`)).status).toBe(200);
    expect(await intakeStore.updateTriageStatusForProject("A", b, "converted")).toBeNull();
    expect((await intakeStore.getItemForProject("B", b))?.triage_status).toBe("new");
  });

  it("validates run ownership before idempotency reuse and scopes same-run retry", async () => {
    const foreign = await commandStore.createRun({
      project_id: "B",
      actor: "user",
      raw_input: "foreign",
    });
    await commandStore.updateResult(
      foreign.id,
      { success: true, summary: "Private B result", steps: [] },
      "reused-key"
    );
    expect((await request(app).get(`/projects/A/commands/${foreign.id}`)).status).toBe(404);
    expect(
      (
        await request(app)
          .post("/projects/A/commands/apply")
          .send({ commandRunId: foreign.id, idempotencyKey: "reused-key" })
      ).status
    ).toBe(404);
    expect((await commandExecutor.execute("A", foreign.id, "reused-key")).success).toBe(false);
    const own = await commandStore.createRun({ project_id: "A", actor: "user", raw_input: "list" });
    await commandStore.updateInterpretation(
      own.id,
      { commandType: "list_intake", args: {} },
      "safe"
    );
    const executed = await commandExecutor.execute("A", own.id, "reused-key");
    expect(executed.success).toBe(true);
    expect(executed.summary).not.toContain("Private B");
    expect(await commandExecutor.execute("A", own.id, "reused-key")).toEqual(executed);
    const other = await commandStore.createRun({
      project_id: "A",
      actor: "user",
      raw_input: "other",
    });
    await commandStore.updateInterpretation(
      other.id,
      { commandType: "convert_intake", args: { itemIds: [a], action: "to_task_draft" } },
      "mutating-low-risk"
    );
    expect((await commandExecutor.execute("A", other.id, "reused-key")).summary).toContain(
      "Converted 1/1"
    );
  });

  it("omits foreign command preview details and reports failed conversion steps", async () => {
    const interpretation = {
      intent: {
        commandType: "convert_intake" as const,
        args: { itemIds: [a, b], action: "to_task_draft" as const },
      },
      riskLevel: "mutating-low-risk" as const,
      confidence: 1,
    };
    const preview = await commandPreview.generatePreview("A", interpretation);
    expect(preview.mutations).toHaveLength(1);
    expect(JSON.stringify(preview)).not.toContain("Private B title");
    const run = await commandStore.createRun({
      project_id: "A",
      actor: "user",
      raw_input: "convert",
    });
    await commandStore.updateInterpretation(
      run.id,
      interpretation.intent,
      interpretation.riskLevel
    );
    const result = await request(app)
      .post("/projects/A/commands/apply")
      .send({ commandRunId: run.id });
    expect(result.body.data.result).toMatchObject({
      success: false,
      summary: "Converted 1/2 intake items",
    });
    expect((await intakeStore.getItemForProject("B", b))?.triage_status).toBe("new");
    expect((await request(app).get(`/projects/A/commands/${run.id}`)).status).toBe(200);
  });
});
